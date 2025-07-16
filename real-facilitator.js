const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const {
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.FACILITATOR_PORT || 3011;

// ✅ NEW: Facilitator keypair for paying fees
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
console.log('PRIVATE KEY:', process.env.FACILITATOR_PRIVATE_KEY);
let facilitatorKeypair;

try {
  if (FACILITATOR_PRIVATE_KEY) {
    facilitatorKeypair = Keypair.fromSecretKey(bs58.decode(FACILITATOR_PRIVATE_KEY));
  } else {
    console.warn('⚠️ No FACILITATOR_PRIVATE_KEY provided, generating temporary keypair...');
    facilitatorKeypair = Keypair.generate();
    console.log(`🔑 Temporary facilitator public key: ${facilitatorKeypair.publicKey.toBase58()}`);

    console.log(`💡 Set FACILITATOR_PRIVATE_KEY environment variable for production use`);
  }
} catch (error) {
  console.warn('⚠️ Could not load facilitator keypair, generating temporary one...');
  facilitatorKeypair = Keypair.generate();
  console.log(`🔑 Temporary facilitator public key: ${facilitatorKeypair.publicKey.toBase58()}`);
}

// Real Solana connections
const connections = {
  'solana-devnet': new Connection('https://api.devnet.solana.com', 'confirmed'),
  'solana-mainnet': new Connection('https://api.mainnet-beta.solana.com', 'confirmed'),
  'solana-testnet': new Connection('https://api.testnet.solana.com', 'confirmed')
};

/**
 * ✅ NEW: Create transaction with facilitator as fee payer
 */
async function createFacilitatorPaidTransaction(
  connection,
  userPublicKey,
  paymentRequirements
) {
  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Create SPL token transfer instruction
  const userTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(paymentRequirements.asset),
    new PublicKey(userPublicKey)
  );

  const recipientTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(paymentRequirements.asset),
    new PublicKey(paymentRequirements.payTo)
  );

  const transferInstruction = createTransferInstruction(
    userTokenAccount,
    recipientTokenAccount,
    new PublicKey(userPublicKey), // User is authority for token transfer
    BigInt(paymentRequirements.maxAmountRequired),
    [],
    TOKEN_PROGRAM_ID
  );

  // ✅ Create transaction with FACILITATOR as fee payer
  const transaction = new Transaction().add(transferInstruction);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = facilitatorKeypair.publicKey; // 🎯 FACILITATOR PAYS FEES!

  // ✅ Add user as required signer for token transfer
  const userPubKey = new PublicKey(userPublicKey);
  if (!transaction.signatures.find(sig => sig.publicKey.equals(userPubKey))) {
    transaction.signatures.push({
      publicKey: userPubKey,
      signature: null // User will sign this
    });
  }

  console.log(`🔍 Transaction signers after adding user:`);
  console.log(`   Facilitator: ${facilitatorKeypair.publicKey.toBase58()}`);
  console.log(`   User: ${userPublicKey}`);
  console.log(`   Total signers: ${transaction.signatures.length}`);

  // Facilitator signs first (for fee payment)
  transaction.partialSign(facilitatorKeypair);

  return transaction;
}

/**
 * Helper to determine payload format and extract transaction data
 */
function extractTransactionData(paymentPayload) {
  const payload = paymentPayload.payload;

  if (!payload) {
    throw new Error('Missing payload in payment');
  }

  // ✅ NEW: Handle facilitator-sponsored format
  if (payload.userSignature && payload.facilitatorTransaction && payload.userPublicKey) {
    return {
      userSignature: payload.userSignature,
      facilitatorTransaction: payload.facilitatorTransaction,
      userPublicKey: payload.userPublicKey,
      format: 'facilitator_sponsored'
    };
  }

  // Check if it's a minimal format (just signature + transaction)
  if (payload.signature && payload.transaction && !payload.payer) {
    return {
      signature: payload.signature,
      transaction: payload.transaction,
      format: 'minimal'
    };
  }

  // Check if it's full format (with all fields)
  if (payload.signature && payload.transaction && payload.payer) {
    return {
      signature: payload.signature,
      transaction: payload.transaction,
      payer: payload.payer,
      amount: payload.amount,
      mint: payload.mint,
      recipient: payload.recipient,
      blockhash: payload.blockhash,
      memo: payload.memo,
      format: 'full'
    };
  }

  // Handle authorization format (converted from middleware)
  if (payload.signature && payload.authorization && !payload.transaction) {
    console.log('🔄 Detected authorization format from middleware - this is expected...');

    return {
      signature: payload.signature,
      payer: payload.authorization.from,
      recipient: payload.authorization.to,
      amount: payload.authorization.value,
      memo: payload.authorization.nonce,
      format: 'authorization_only'
    };
  }

  const availableFields = Object.keys(payload);
  throw new Error(`Unrecognized payload format. Available fields: ${availableFields.join(', ')}. Expected: signature + transaction (+ optional payer, amount, etc.)`);
}

/**
 * Settlement helper using proper Solana methods
 */
async function settleSolanaTransaction(connection, transactionBase64, options = {}) {
  const {
    skipPreflight = false,
    maxRetries = 3,
    timeout = 30000
  } = options;

  // Decode and broadcast transaction
  const transactionBuffer = Buffer.from(transactionBase64, 'base64');
  const transaction = Transaction.from(transactionBuffer);

  console.log(`🚀 Broadcasting transaction...`);
  console.log(`   Fee Payer: ${transaction.feePayer.toBase58()}`);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight,
      preflightCommitment: 'confirmed',
      maxRetries
    }
  );

  console.log(`📡 Transaction broadcasted! Signature: ${signature}`);

  // Wait for confirmation with timeout
  const startTime = Date.now();
  let confirmed = false;
  let confirmationStatus = 'processed';
  let slot = null;
  let blockTime = null;
  let fees = null;

  while (Date.now() - startTime < timeout && !confirmed) {
    try {
      const status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true
      });

      if (status.value) {
        confirmationStatus = status.value.confirmationStatus || 'processed';

        if (status.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }

        if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
          confirmed = true;

          // Get transaction details
          try {
            const txInfo = await connection.getTransaction(signature, {
              commitment: 'confirmed'
            });
            slot = txInfo?.slot;
            blockTime = txInfo?.blockTime;
            fees = txInfo?.meta?.fee;
          } catch (detailError) {
            console.warn('⚠️ Could not fetch transaction details:', detailError.message);
          }
          break;
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (statusError) {
      console.warn('⚠️ Status check error:', statusError.message);
    }
  }

  return {
    signature,
    confirmed,
    confirmationStatus,
    slot,
    blockTime,
    fees
  };
}

app.get('/supported', (req, res) => {
  res.json({
    kinds: [
      {
        x402Version: 1,
        scheme: 'exact',
        network: 'solana-devnet',
        facilitatorPaysGas: true, // ✅ NEW: Indicate gas sponsorship capability
        facilitatorPublicKey: facilitatorKeypair.publicKey.toBase58()
      },
      {
        x402Version: 1,
        scheme: 'exact',
        network: 'solana-mainnet',
        facilitatorPaysGas: true,
        facilitatorPublicKey: facilitatorKeypair.publicKey.toBase58()
      },
      {
        x402Version: 1,
        scheme: 'exact',
        network: 'solana-testnet',
        facilitatorPaysGas: true,
        facilitatorPublicKey: facilitatorKeypair.publicKey.toBase58()
      }
    ]
  });
});

// ✅ NEW: Endpoint to create facilitator-sponsored transaction
app.post('/create-sponsored-transaction', async (req, res) => {
  console.log('🔧 Create sponsored transaction request:', JSON.stringify(req.body, null, 2));

  const { userPublicKey, paymentRequirements } = req.body;

  try {
    if (!userPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing userPublicKey'
      });
    }

    if (!paymentRequirements) {
      return res.status(400).json({
        success: false,
        error: 'Missing paymentRequirements'
      });
    }

    const network = paymentRequirements.network;
    const connection = connections[network];

    if (!connection) {
      return res.status(400).json({
        success: false,
        error: `Unsupported network: ${network}`
      });
    }

    // Create transaction with facilitator as fee payer
    const transaction = await createFacilitatorPaidTransaction(
      connection,
      userPublicKey,
      paymentRequirements
    );

    console.log('✅ Facilitator-sponsored transaction created!');
    console.log(`   Fee Payer: ${transaction.feePayer.toBase58()} (Facilitator)`);
    console.log(`   User Authority: ${userPublicKey}`);
    console.log(`   Amount: ${paymentRequirements.maxAmountRequired}`);
    console.log(`   Token: ${paymentRequirements.asset}`);

    res.json({
      success: true,
      transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64'),
      facilitatorPublicKey: facilitatorKeypair.publicKey.toBase58(),
      message: 'Transaction created with facilitator as fee payer. User needs to sign for token transfer authority.',
      blockhash: transaction.recentBlockhash,
      feePaidBy: 'facilitator'
    });

  } catch (error) {
    console.error('❌ Error creating sponsored transaction:', error);
    res.status(400).json({
      success: false,
      error: `Failed to create sponsored transaction: ${error.message}`
    });
  }
});

app.post('/verify', async (req, res) => {
  console.log('🔍 REAL Verify request received:', JSON.stringify(req.body, null, 2));

  const { paymentPayload, paymentRequirements } = req.body;

  try {
    // Basic validation
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Missing paymentPayload or paymentRequirements'
      });
    }

    // Check if it's a Solana network
    const network = paymentPayload.network;
    if (!network || !network.startsWith('solana-')) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Unsupported network - only Solana networks supported'
      });
    }

    const connection = connections[network];
    if (!connection) {
      return res.status(400).json({
        isValid: false,
        invalidReason: `Unsupported network: ${network}`
      });
    }

    let transactionData;
    try {
      transactionData = extractTransactionData(paymentPayload);
    } catch (extractError) {
      return res.status(400).json({
        isValid: false,
        invalidReason: `Invalid payload format: ${extractError.message}`
      });
    }

    const { signature, transaction, format } = transactionData;

    try {
      // ✅ NEW: Handle facilitator-sponsored format
      if (format === 'facilitator_sponsored') {
        console.log('🔍 Verifying facilitator-sponsored transaction...');

        const transactionBuffer = Buffer.from(transactionData.facilitatorTransaction, 'base64');
        const tx = Transaction.from(transactionBuffer);

        // Verify facilitator is the fee payer
        if (!tx.feePayer.equals(facilitatorKeypair.publicKey)) {
          return res.status(400).json({
            isValid: false,
            invalidReason: 'Transaction fee payer is not the facilitator'
          });
        }

        // Simulate transaction
        const simulation = await connection.simulateTransaction(tx, undefined, 'confirmed');

        if (simulation.value.err) {
          return res.status(400).json({
            isValid: false,
            invalidReason: `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`
          });
        }

        console.log('✅ Facilitator-sponsored transaction verified!');
      }
      // Handle other formats as before...
      else if (format === 'authorization_only') {
        console.log('🔍 Verifying authorization-only format (checking if transaction exists on-chain)...');

        try {
          const existingTx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });

          if (!existingTx) {
            return res.status(400).json({
              isValid: false,
              invalidReason: 'Transaction not found on blockchain - payment may not have been submitted yet'
            });
          }

          if (existingTx.meta?.err) {
            return res.status(400).json({
              isValid: false,
              invalidReason: `Transaction failed on blockchain: ${JSON.stringify(existingTx.meta.err)}`
            });
          }

          console.log('✅ Transaction found on blockchain and confirmed!');
        } catch (err) {
          return res.status(400).json({
            isValid: false,
            invalidReason: 'Unable to verify transaction on blockchain'
          });
        }
      } else {
        // Handle full transaction formats (minimal/full)
        if (!transaction) {
          return res.status(400).json({
            isValid: false,
            invalidReason: 'Missing transaction data for full verification'
          });
        }

        // Decode and validate transaction structure
        const transactionBuffer = Buffer.from(transaction, 'base64');
        const tx = Transaction.from(transactionBuffer);

        // Simulate transaction to check if it would succeed
        const simulation = await connection.simulateTransaction(tx, undefined, 'confirmed');

        if (simulation.value.err) {
          return res.status(400).json({
            isValid: false,
            invalidReason: `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`
          });
        }

        // Verify transaction hasn't been executed yet
        try {
          const existingTx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });

          if (existingTx) {
            return res.status(400).json({
              isValid: false,
              invalidReason: 'Transaction already executed on blockchain'
            });
          }
        } catch (err) {
          // Transaction not found is good - means it hasn't been executed
        }
      }

      console.log(`✅ Transaction verified and ready for settlement!`);
      console.log(`   Network: ${network}`);
      console.log(`   Format: ${transactionData.format}`);
      console.log(`   Transaction valid: Yes`);

      res.json({
        isValid: true,
        invalidReason: null,
        payer: format === 'facilitator_sponsored' ?
          facilitatorKeypair.publicKey.toBase58() :
          (transactionData.payer || paymentPayload.payload?.authorization?.from || 'unknown'),
        gasSponsoredByFacilitator: format === 'facilitator_sponsored'
      });

    } catch (validationError) {
      console.error('❌ Transaction validation error:', validationError);
      return res.status(400).json({
        isValid: false,
        invalidReason: `Transaction validation failed: ${validationError.message}`
      });
    }

  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(400).json({
      isValid: false,
      invalidReason: `Verification failed: ${error.message}`
    });
  }
});

app.post('/settle', async (req, res) => {
  console.log('💰 REAL Settle request received:', JSON.stringify(req.body, null, 2));

  const { paymentPayload, paymentRequirements } = req.body;

  try {
    const network = paymentPayload.network;
    const connection = connections[network];

    if (!connection) {
      throw new Error('Invalid settlement request: unsupported network');
    }

    let transactionData;
    try {
      transactionData = extractTransactionData(paymentPayload);
    } catch (extractError) {
      throw new Error(`Invalid payload format: ${extractError.message}`);
    }

    const { transaction, signature, format } = transactionData;

    console.log(`🚀 Settlement starting for ${network}...`);
    console.log(`   Format: ${format}`);

    let result;

    // ✅ NEW: Handle facilitator-sponsored transactions
    if (format === 'facilitator_sponsored') {
      console.log('💰 Processing facilitator-sponsored transaction...');
      console.log(`   Facilitator pays fees: YES`);
      console.log(`   User pays: 0 SOL`);

      // Broadcast the facilitator-sponsored transaction
      result = await settleSolanaTransaction(connection, transactionData.facilitatorTransaction, {
        skipPreflight: false,
        maxRetries: 3,
        timeout: 30000
      });

      if (!result.confirmed) {
        throw new Error(`Facilitator-sponsored transaction not confirmed within timeout. Status: ${result.confirmationStatus}`);
      }

      console.log('✅ Facilitator-sponsored transaction settled successfully!');
      console.log(`   User gas cost: 0 SOL (facilitator paid: ${result.fees} lamports)`);
    }
    else if (format === 'authorization_only') {
      console.log('🔍 Authorization-only format - checking existing transaction...');

      // For authorization format, transaction was already submitted by wallet
      try {
        const existingTx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (!existingTx) {
          throw new Error('Transaction not found on blockchain');
        }

        if (existingTx.meta?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(existingTx.meta.err)}`);
        }

        result = {
          signature: signature,
          confirmed: true,
          confirmationStatus: 'confirmed',
          slot: existingTx.slot,
          blockTime: existingTx.blockTime,
          fees: existingTx.meta?.fee
        };

        console.log('✅ Found and verified existing transaction!');
      } catch (error) {
        throw new Error(`Failed to verify existing transaction: ${error.message}`);
      }
    } else {
      // Handle full transaction formats - broadcast the transaction
      if (!transaction) {
        throw new Error('Missing transaction data for settlement');
      }

      console.log('📡 Broadcasting new transaction...');
      result = await settleSolanaTransaction(connection, transaction, {
        skipPreflight: false,
        maxRetries: 3,
        timeout: 30000
      });

      if (!result.confirmed) {
        throw new Error(`Transaction not confirmed within timeout. Status: ${result.confirmationStatus}`);
      }
    }

    console.log('✅ Solana payment settlement completed');
    console.log(`   Signature: ${result.signature}`);
    console.log(`   Network: ${network}`);
    console.log(`   Confirmation: ${result.confirmationStatus}`);
    console.log(`   Slot: ${result.slot}`);
    console.log(`   Fees: ${result.fees} lamports`);

    res.json({
      success: true,
      errorReason: null,
      transaction: result.signature,
      network: network,
      payer: format === 'facilitator_sponsored' ?
        facilitatorKeypair.publicKey.toBase58() :
        (transactionData.payer || paymentPayload.payload?.authorization?.from || 'unknown'),
      confirmationStatus: result.confirmationStatus,
      slot: result.slot,
      blockTime: result.blockTime,
      fees: result.fees,
      gasSponsoredByFacilitator: format === 'facilitator_sponsored',
      userPaidGas: format !== 'facilitator_sponsored'
    });

  } catch (error) {
    console.error('❌ Settlement error:', error);
    res.status(400).json({
      success: false,
      errorReason: `Settlement failed: ${error.message}`,
      transaction: null,
      network: paymentPayload.network,
      payer: null
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'real-solana-x402-facilitator',
    timestamp: new Date().toISOString(),
    supportedNetworks: ['solana-devnet', 'solana-mainnet', 'solana-testnet'],
    mode: 'REAL_SETTLEMENT_WITH_GAS_SPONSORSHIP', // ✅ Updated mode
    facilitatorPublicKey: facilitatorKeypair.publicKey.toBase58(),
    features: [
      'transaction broadcasting',
      'facilitator gas sponsorship', // ✅ NEW
      'authorization format support',
      'full payload support'
    ],
    note: 'This facilitator can pay gas fees for users via sponsored transactions',
    payloadFormats: [
      'minimal (signature + transaction)',
      'full (with payer, amount, etc.)',
      'authorization_only (from middleware)',
      'facilitator_sponsored (facilitator pays gas)' // ✅ NEW
    ],
    endpoints: {
      '/create-sponsored-transaction': 'Create transaction with facilitator as fee payer',
      '/verify': 'Verify payment (supports gas sponsorship)',
      '/settle': 'Settle payment (facilitator can pay gas)',
      '/supported': 'Get supported payment types'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🏦 REAL Solana X402 Facilitator running on port ${PORT}`);
  console.log(`📍 Available at http://localhost:${PORT}`);
  console.log(`🔍 Supported networks: solana-devnet, solana-mainnet, solana-testnet`);
  console.log(`⚡ This facilitator performs REAL transaction broadcasting!`);
  console.log(`💰 NEW: Facilitator can pay gas fees for users!`); // ✅ NEW
  console.log(`🔑 Facilitator public key: ${facilitatorKeypair.publicKey.toBase58()}`);
  console.log(`🎯 Ready for gas-sponsored transactions`); // ✅ NEW
});

module.exports = app; 