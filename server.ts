// solana-paywall-server/index.js
import express from 'express';
import cors from 'cors';
import { solanaPaymentMiddleware } from '@cheapay/x402-express';
import { TokenMint } from '@cheapay/x402';

const app = express();
const PORT = process.env.PORT || 3000;

const PAYMENT_RECIPIENT = '58bAvxQ9kAMxemwNNaYt3zHBckduj2coV3zeypUrMsuV';

app.use(cors());
app.use(express.json());

// Middleware with paywall UI (facilitator sponsored)
app.use('/api/premium', solanaPaymentMiddleware({
    payTo: PAYMENT_RECIPIENT,
    routes: {
        '/*': {
            price: '$0.01',
            network: 'solana-devnet',
            mint: TokenMint.USDC.devnet,
            description: 'Access premium API (USDC, devnet)',
            maxTimeoutSeconds: 120
        }
    },
    facilitator: {
        url: 'http://localhost:3011',
        broadcastMode: 'facilitator_sponsored'
    },
    paywall: {
        appName: 'Solana Paywall Server',
        walletAdapters: ['phantom', 'solflare', 'backpack'],
        enableUserSelfBroadcast: false
    },
}));

app.get('/api/premium/data', (req, res) => {
    res.json({
        message: '✅ Bạn đã thanh toán để xem nội dung này.',
        timestamp: new Date().toISOString(),
        network: 'solana-devnet',
        token: 'USDC'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'solana-paywall-server',
        timestamp: new Date().toISOString()
    });
});

// Group endpoints by network for homepage rendering
const groupedEndpoints = [
    {
        network: 'Solana Devnet',
        endpoints: [
            {
                path: '/api/premium/data',
                desc: '$0.01 USDC (Facilitator pays gas, devnet)'
            },
            {
                path: '/api/self-pay/data',
                desc: '$0.02 USDC (User pays gas, devnet)'
            },
            {
                path: '/api/sol-premium',
                desc: '0.001 SOL (Facilitator sponsored, devnet)'
            },
            {
                path: '/api/usdc-premium',
                desc: '1 USDC (Facilitator sponsored, devnet)'
            },
            {
                path: '/api/devnet/usdc-premium/data',
                desc: '1 USDC (Facilitator sponsored, devnet, new endpoint)'
            }
        ]
    },
    {
        network: 'Other',
        endpoints: [
            {
                path: '/health',
                desc: 'Free endpoint (no payment required)'
            }
        ]
    }
];


app.get('/', (req, res) => {
    res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
        <h1>🚀 Solana x402 Payment Demo</h1>
        <p>This demo shows Solana payments integration with Express.js using the x402 protocol.</p>
        <h2>📱 Available Endpoints:</h2>
        ${groupedEndpoints.map(group => `
          <h3>${group.network}</h3>
          <ul>
            ${group.endpoints.map(e => `<li><strong><a href="${e.path}">${e.path}</a></strong> - ${e.desc}</li>`).join('')}
          </ul>
        `).join('')}
        <h2>💧 Devnet Faucets</h2>
        <ul>
          <li><a href="https://faucet.solana.com/" target="_blank" rel="noopener">Solana Devnet SOL Faucet</a> (Get free SOL for devnet)</li>
          <li><a href="https://faucet.circle.com/" target="_blank" rel="noopener">Circle USDC Faucet</a> (Get free USDC for Solana Devnet)</li>
        </ul>
        <h2>🔥 Broadcast Modes:</h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
          <div style="background: #f0f8ff; padding: 15px; border-radius: 8px;">
            <h3>🏦 Facilitator Sponsored</h3>
            <ul>
              <li>✅ User pays only content price</li>
              <li>✅ Facilitator pays gas fees</li>
              <li>✅ Best UX - lowest user cost</li>
              <li>⚠️ Requires facilitator setup</li>
            </ul>
          </div>
          <div style="background: #fff5f5; padding: 15px; border-radius: 8px;">
            <h3>🔥 User Self-Broadcast</h3>
            <ul>
              <li>✅ No facilitator gas cost</li>
              <li>✅ Direct wallet interaction</li>
              <li>✅ Full user control</li>
              <li>⚠️ User pays content + gas</li>
            </ul>
          </div>
        </div>
        <h2>🛠 Technical Details:</h2>
        <ul>
          <li><strong>Protocol:</strong> x402 Payment Protocol</li>
          <li><strong>Blockchain:</strong> Solana (devnet/mainnet)</li>
          <li><strong>Tokens:</strong> USDC, BONK, or any SPL token</li>
          <li><strong>Wallets:</strong> Phantom, Solflare, Backpack, Privy</li>
          <li><strong>Broadcast Modes:</strong> Facilitator-sponsored or User-self-broadcast</li>
        </ul>
        <div style="background: #f0f8ff; padding: 15px; border-radius: 8px; margin-top: 20px;">
          <strong>💡 Developer Tip:</strong> 
          Choose facilitator-sponsored for best UX, user-self-broadcast for lowest infrastructure cost!
        </div>
      </body>
    </html>
  `);
});


app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
