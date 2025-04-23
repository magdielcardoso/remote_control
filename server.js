const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { AndroidRemote, RemoteKeyCode, RemoteDirection } = require('androidtv-remote');
const path = require('path');
const arp = require('node-arp');
const { exec } = require('child_process');
const os = require('os');

// Mapeamento de teclas para os enums corretos
const KeyMap = {
    'POWER': 26,  // KEYCODE_POWER
    'HOME': 3,    // KEYCODE_HOME
    'BACK': 4,    // KEYCODE_BACK
    'DPAD_UP': 19,    // KEYCODE_DPAD_UP
    'DPAD_DOWN': 20,  // KEYCODE_DPAD_DOWN
    'DPAD_LEFT': 21,  // KEYCODE_DPAD_LEFT
    'DPAD_RIGHT': 22, // KEYCODE_DPAD_RIGHT
    'DPAD_CENTER': 23,// KEYCODE_DPAD_CENTER
    'VOLUME_UP': 24,  // KEYCODE_VOLUME_UP
    'VOLUME_DOWN': 25,// KEYCODE_VOLUME_DOWN
    'VOLUME_MUTE': 164,// KEYCODE_VOLUME_MUTE
    'MENU': 82,   // KEYCODE_MENU
    'ENTER': 66   // KEYCODE_ENTER
};

// Configurações
let TV_IP = null;
const TV_CONFIG = {
    pairing_port: 6467,
    remote_port: 6466,
    name: 'web-remote-control'
};

// Configurar Express
app.use(express.static('public'));
app.use(express.json());

// Rota principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rotas HTTP REST
app.post('/api/scan', async (req, res) => {
    try {
        const tvs = await findTVs();
        res.json({ success: true, tvs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/connect', async (req, res) => {
    try {
        const { ip } = req.body;
        await connectToTV(ip);
        res.json({ success: true, message: 'Conexão iniciada' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pair', (req, res) => {
    try {
        const { code } = req.body;
        if (!tvRemote) {
            throw new Error('TV não conectada');
        }
        tvRemote.sendCode(code);
        res.json({ success: true, message: 'Código enviado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/key', (req, res) => {
    try {
        const { keyCode, direction = 'SHORT' } = req.body;
        if (!tvRemote) {
            throw new Error('TV não conectada');
        }
        
        const validKeyCode = KeyMap[keyCode];
        if (!validKeyCode) {
            throw new Error(`Tecla inválida: ${keyCode}`);
        }

        const validDirection = direction === 'SHORT' ? 
            RemoteDirection.SHORT : 
            direction === 'START_LONG' ? 
                RemoteDirection.START_LONG : 
                RemoteDirection.END_LONG;

        tvRemote.sendKey(validKeyCode, validDirection);
        res.json({ success: true, message: 'Comando enviado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/app', (req, res) => {
    try {
        const { appLink } = req.body;
        if (!tvRemote) {
            throw new Error('TV não conectada');
        }
        tvRemote.sendAppLink(appLink);
        res.json({ success: true, message: 'App link enviado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para obter o IP base da rede local
function getLocalNetworkBase() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            // Pular interfaces não IPv4 e localhost
            if (interface.family !== 'IPv4' || interface.internal) {
                continue;
            }
            // Retorna o IP base (ex: 192.168.1)
            const ipParts = interface.address.split('.');
            return ipParts.slice(0, 3).join('.');
        }
    }
    return '192.168.1'; // fallback
}

// Descobrir dispositivos na rede
async function findTVs() {
    return new Promise(async (resolve) => {
        const devices = [];
        const baseIp = getLocalNetworkBase();
        let completed = 0;
        const total = 255; // Escanear toda a faixa de IPs

        console.log(`Escaneando rede ${baseIp}.*...`);

        // Função para verificar uma porta específica
        const checkPort = (ip) => {
            return new Promise((portResolve) => {
                const socket = new (require('net')).Socket();
                socket.setTimeout(200); // timeout rápido

                socket.on('connect', () => {
                    socket.destroy();
                    portResolve(true);
                });

                socket.on('timeout', () => {
                    socket.destroy();
                    portResolve(false);
                });

                socket.on('error', () => {
                    socket.destroy();
                    portResolve(false);
                });

                socket.connect(TV_CONFIG.remote_port, ip);
            });
        };

        // Verifica cada IP na rede
        for (let i = 1; i <= total; i++) {
            const ip = `${baseIp}.${i}`;
            
            try {
                const hasPort = await checkPort(ip);
                if (hasPort) {
                    console.log(`Dispositivo encontrado em ${ip}`);
                    devices.push({
                        ip: ip,
                        type: 'Possível Android TV'
                    });
                }
            } catch (error) {
                console.log(`Erro ao verificar ${ip}:`, error);
            }

            completed++;
            if (completed === total) {
                console.log('Busca finalizada');
                resolve(devices);
            }
        }
    });
}

// Gerenciar conexão com a TV
let tvRemote = null;
let tvCertificate = null;

async function connectToTV(ip = null) {
    try {
        if (!ip) {
            const tvs = await findTVs();
            if (tvs.length > 0) {
                TV_IP = tvs[0].ip;
                io.emit('tvs-found', tvs);
            } else {
                throw new Error('Nenhuma TV encontrada na rede');
            }
        } else {
            TV_IP = ip;
        }

        tvRemote = new AndroidRemote(TV_IP, {
            ...TV_CONFIG,
            cert: tvCertificate
        });

        tvRemote.on('secret', () => {
            io.emit('pairing-required');
        });

        tvRemote.on('powered', (powered) => {
            io.emit('tv-power', powered);
        });

        tvRemote.on('volume', (volume) => {
            io.emit('tv-volume', volume);
        });

        tvRemote.on('current_app', (app) => {
            io.emit('tv-app', app);
        });

        tvRemote.on('ready', () => {
            tvCertificate = tvRemote.getCertificate();
            io.emit('tv-connected', TV_IP);
        });

        await tvRemote.start();
    } catch (error) {
        console.error('Erro ao conectar com a TV:', error);
        io.emit('tv-error', error.message);
    }
}

// Socket.IO eventos
io.on('connection', (socket) => {
    console.log('Cliente conectado');

    socket.on('scan-network', async () => {
        const tvs = await findTVs();
        socket.emit('tvs-found', tvs);
    });

    socket.on('connect-tv', (ip = null) => {
        connectToTV(ip);
    });

    socket.on('send-pairing-code', (code) => {
        if (tvRemote) {
            tvRemote.sendCode(code);
        }
    });

    socket.on('send-key', ({ keyCode, direction = 'SHORT' }) => {
        if (tvRemote) {
            try {
                const validKeyCode = KeyMap[keyCode];
                if (!validKeyCode) {
                    throw new Error(`Tecla inválida: ${keyCode}`);
                }

                const validDirection = direction === 'SHORT' ? 
                    RemoteDirection.SHORT : 
                    direction === 'START_LONG' ? 
                        RemoteDirection.START_LONG : 
                        RemoteDirection.END_LONG;

                console.log('Enviando comando:', keyCode, direction);
                tvRemote.sendKey(validKeyCode, validDirection);
            } catch (error) {
                console.error('Erro ao enviar comando:', error);
                socket.emit('tv-error', error.message);
            }
        }
    });

    socket.on('open-app', (appLink) => {
        if (tvRemote) {
            tvRemote.sendAppLink(appLink);
        }
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
}); 