// server.js - Session Generator Backend pour Render
import express from 'express';
import { 
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store temporaire des sessions en cours
const activeSessions = new Map();

// Fonction pour nettoyer les anciennes sessions (>5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now - session.createdAt > 5 * 60 * 1000) {
            // Nettoyer les fichiers
            try {
                if (fs.existsSync(session.sessionPath)) {
                    fs.rmSync(session.sessionPath, { recursive: true, force: true });
                }
            } catch (err) {
                console.error('Cleanup error:', err);
            }
            activeSessions.delete(token);
            console.log(`🗑️  Session ${token} expired and cleaned`);
        }
    }
}, 60000); // Toutes les minutes

// API: Générer une session
app.post('/api/generate-session', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber || phoneNumber.length < 8) {
            return res.status(400).json({ error: 'Numéro de téléphone invalide' });
        }

        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const sessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const sessionPath = path.join(__dirname, 'temp_sessions', sessionToken);

        console.log(`🚀 Generating session for ${cleanNumber}...`);

        // Créer le dossier de session
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            browser: ["Session Generator", "Chrome", "1.0.0"],
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            fireInitQueries: false,
            emitOwnEvents: false
        });

        let pairingCode = null;
        let sessionCompleted = false;

        // Store session info
        activeSessions.set(sessionToken, {
            phoneNumber: cleanNumber,
            sessionPath,
            sock,
            createdAt: Date.now(),
            sessionId: null,
            connected: false
        });

        // Gérer les événements de connexion
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open' && !sessionCompleted) {
                console.log(`✅ Session connected for ${cleanNumber}`);
                sessionCompleted = true;

                try {
                    // Lire le fichier creds.json
                    const credsPath = path.join(sessionPath, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const credsData = fs.readFileSync(credsPath, 'utf-8');
                        
                        // Encoder en Base64 pour faciliter le transport
                        const sessionId = Buffer.from(credsData).toString('base64');
                        
                        const session = activeSessions.get(sessionToken);
                        if (session) {
                            session.sessionId = sessionId;
                            session.connected = true;
                        }

                        console.log(`📦 Session ID generated for ${cleanNumber}`);

                        // Déconnecter proprement
                        setTimeout(async () => {
                            try {
                                await sock.logout();
                            } catch (err) {
                                console.error('Logout error:', err);
                            }
                        }, 2000);
                    }
                } catch (error) {
                    console.error('Error reading creds:', error);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log(`⚠️  Connection closed for ${cleanNumber}, code: ${statusCode}`);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Demander le code de pairage
        setTimeout(async () => {
            if (!state.creds.registered) {
                try {
                    pairingCode = await sock.requestPairingCode(cleanNumber);
                    console.log(`🔑 Pairing code for ${cleanNumber}: ${pairingCode}`);
                    
                    const session = activeSessions.get(sessionToken);
                    if (session) {
                        session.pairingCode = pairingCode;
                    }
                } catch (error) {
                    console.error('Pairing code error:', error);
                }
            }
        }, 2000);

        // Attendre que le code soit généré
        await new Promise(resolve => setTimeout(resolve, 3000));

        const session = activeSessions.get(sessionToken);
        if (session && session.pairingCode) {
            res.json({
                success: true,
                sessionToken,
                pairingCode: session.pairingCode
            });
        } else {
            throw new Error('Failed to generate pairing code');
        }

    } catch (error) {
        console.error('Session generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Vérifier le statut de la session
app.get('/api/check-session/:token', (req, res) => {
    try {
        const { token } = req.params;
        const session = activeSessions.get(token);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (session.sessionId) {
            // Nettoyer les fichiers temporaires
            setTimeout(() => {
                try {
                    if (fs.existsSync(session.sessionPath)) {
                        fs.rmSync(session.sessionPath, { recursive: true, force: true });
                    }
                    activeSessions.delete(token);
                    console.log(`🧹 Session ${token} cleaned after retrieval`);
                } catch (err) {
                    console.error('Cleanup error:', err);
                }
            }, 5000);

            return res.json({
                success: true,
                sessionId: session.sessionId,
                phoneNumber: session.phoneNumber
            });
        }

        res.json({
            success: false,
            waiting: true
        });

    } catch (error) {
        console.error('Check session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API: Santé du serveur
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        activeSessions: activeSessions.size,
        memory: process.memoryUsage()
    });
});

// Servir le frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, cleaning up...');
    
    // Nettoyer toutes les sessions
    for (const [token, session] of activeSessions.entries()) {
        try {
            if (session.sock) {
                await session.sock.logout();
            }
            if (fs.existsSync(session.sessionPath)) {
                fs.rmSync(session.sessionPath, { recursive: true, force: true });
            }
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    }
    
    process.exit(0);
});

// Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════╗
║     🚀 SESSION GENERATOR SERVER               ║
║                                                ║
║  Server: http://0.0.0.0:${PORT}                ║
║  Status: ✅ READY                              ║
║                                                ║
║  Endpoints:                                    ║
║  • POST /api/generate-session                  ║
║  • GET  /api/check-session/:token              ║
║  • GET  /api/health                            ║
╚════════════════════════════════════════════════╝
    `);
});