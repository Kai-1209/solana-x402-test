import { solanaPaymentMiddleware } from "@cheapay/x402-next";
import { Resource } from "@cheapay/x402/types";

const facilitatorUrl = 'http://localhost:3011';
const payTo = '58bAvxQ9kAMxemwNNaYt3zHBckduj2coV3zeypUrMsuV';
const network = "solana-devnet" as const;

export const middleware = solanaPaymentMiddleware(
  payTo,
  {
    "/protected": {
      price: "$0.01",
      network,
      config: {
        description: "Access to protected content",
      },
    },
  },
  {
    url: facilitatorUrl,
  },
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/protected/:path*"],
};
