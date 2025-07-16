# 🧾 solana-paywall-server

This is a sample **Express.js server** that uses [`@cheapay/x402-express`](https://www.npmjs.com/package/@cheapay/x402-express) to protect routes with **Solana-based payment middleware**.

---

## 🧪 Test Objectives

- ✅ Middleware blocks requests until payment is made.
- ✅ UI automatically prompts the user with Solana wallet options (Phantom, Solflare, etc.).
- ✅ After successful payment, the user is granted access to the protected content.

---

## ⚙️ Sample Configuration (`server.js`)

```ts
import express from "express";
import cors from "cors";
import { solanaPaymentMiddleware } from "@cheapay/x402-express";
import { TokenMint } from "@cheapay/x402";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.use(
  solanaPaymentMiddleware({
    payTo: "ADDRESS", // Your wallet address
    routes: {
      "/protected": {
        price: 1000000, // 1 USDC (6 decimals)
        network: "solana-devnet",
        mint: TokenMint.USDC.devnet,
        description: "Access premium content",
        maxTimeoutSeconds: 180,
      },
    },
    facilitator: {
      url: "http://localhost:3011", // Make sure facilitator is running
      broadcastMode: "facilitator_sponsored",
    },
    paywall: {
      appName: "Solana Paywall Demo",
      walletAdapters: ["phantom", "solflare"],
      enableUserSelfBroadcast: false,
    },
  })
);

app.get("/protected", (req, res) => {
  res.send("✅ You have successfully paid and accessed the protected content!");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
