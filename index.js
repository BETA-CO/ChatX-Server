/**
 * ChatX Signaling Server
 * 
 * Handles:
 * 1. Socket.IO signaling for WebRTC call negotiation
 *    - User registration (maps userId → socketId)
 *    - Call invite, accept, decline, end, busy events
 *    - SDP offer/answer forwarding
 *    - ICE candidate relay
 * 
 * 2. FCM push notifications for background call delivery
 *    - POST /send-call-notification endpoint
 *    - Uses Firebase Admin SDK to send data-only messages
 * 
 * Deployment:
 *   - Set environment variables in .env file
 *   - Deploy to Railway, Render, Fly.io, or any Node.js host
 *   - Ensure the URL matches CallService.signalingServerUrl in Flutter
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

try {
  let serviceAccount;

  // Option 1: Parse from a Base64 encoded string (Most robust for Render/Railway)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const jsonStr = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(jsonStr);
    console.log('✅ Loaded Firebase credentials from Base64 Environment Variable');
  }
  // Option 2: Parse from a stringified JSON environment variable
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log('✅ Loaded Firebase credentials from JSON Environment Variable');
  } 
  // Option 3: Fallback to reading from the local file path
  else {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json';
    serviceAccount = require(serviceAccountPath);
    console.log('✅ Loaded Firebase credentials from File:', serviceAccountPath);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK initialized');
} catch (err) {
  console.warn('⚠️  Firebase Admin SDK not initialized (FCM push will not work)');
  console.warn('   Please set FIREBASE_SERVICE_ACCOUNT_JSON env var or place serviceAccountKey.json locally');
  console.warn('   Error:', err.message);
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Maps userId → socketId for routing messages to the correct user
const userSocketMap = new Map();

// ═══════════════════════════════════════════════════════════════════
// SOCKET.IO — Signaling Events
// ═══════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ── User Registration ──
  // When a user connects, they send their Firebase UID so we can
  // map socket connections to user identities.
  socket.on('register', (data) => {
    const userId = data.userId;
    if (userId) {
      userSocketMap.set(userId, socket.id);
      console.log(`📋 Registered: ${userId} → ${socket.id}`);
      console.log(`   Active users: ${userSocketMap.size}`);
    }
  });

  // ── Call Invite ──
  // Caller sends this to invite the receiver to a call.
  socket.on('call_invite', (data) => {
    const targetSocketId = userSocketMap.get(data.receiverId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_invite', data);
      console.log(`📞 Call invite: ${data.callerId} → ${data.receiverId}`);
    } else {
      console.log(`📞 Call invite: receiver ${data.receiverId} is offline`);
    }
  });

  // ── Call Accepted ──
  socket.on('call_accepted', (data) => {
    const targetSocketId = userSocketMap.get(data.callerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_accepted', data);
      console.log(`✅ Call accepted: ${data.receiverId} → ${data.callerId}`);
    }
  });

  // ── Call Declined ──
  socket.on('call_declined', (data) => {
    const targetSocketId = userSocketMap.get(data.callerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_declined', data);
      console.log(`❌ Call declined: ${data.receiverId} → ${data.callerId}`);
    }
  });

  // ── Call Ended ──
  socket.on('call_ended', (data) => {
    const targetSocketId = userSocketMap.get(data.targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_ended', data);
      console.log(`🔚 Call ended: → ${data.targetId}`);
    }
  });

  // ── Call Busy ──
  socket.on('call_busy', (data) => {
    const targetSocketId = userSocketMap.get(data.callerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_busy', data);
      console.log(`🔴 Call busy: → ${data.callerId}`);
    }
  });

  // ── SDP Offer ──
  socket.on('offer', (data) => {
    const targetSocketId = userSocketMap.get(data.targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('offer', data);
      console.log(`📄 SDP offer: → ${data.targetId}`);
    }
  });

  // ── SDP Answer ──
  socket.on('answer', (data) => {
    const targetSocketId = userSocketMap.get(data.targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', data);
      console.log(`📄 SDP answer: → ${data.targetId}`);
    }
  });

  // ── ICE Candidate ──
  socket.on('ice_candidate', (data) => {
    const targetSocketId = userSocketMap.get(data.targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice_candidate', data);
      // ICE candidates are frequent, so we log at a lower level
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason) => {
    // Remove the user from the map
    for (const [userId, socketId] of userSocketMap.entries()) {
      if (socketId === socket.id) {
        userSocketMap.delete(userId);
        console.log(`🔌 Disconnected: ${userId} (${reason})`);
        break;
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// HTTP — FCM Push Notification Endpoint
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /send-call-notification
 * 
 * Sends an FCM data-only message to the receiver's device to trigger
 * the flutter_callkit_incoming native call UI.
 * 
 * Request body:
 * {
 *   "receiverId": "firebase-uid",
 *   "callId": "uuid",
 *   "callerName": "Display Name",
 *   "callType": "voice" | "video",
 *   "callerId": "firebase-uid",
 *   "callerEmail": "email@example.com"
 * }
 */
app.post('/send-call-notification', async (req, res) => {
  try {
    const { receiverId, callId, callerName, callType, callerId, callerEmail } = req.body;

    if (!receiverId || !callId) {
      return res.status(400).json({ error: 'Missing receiverId or callId' });
    }

    // Look up the receiver's FCM token from Firestore
    const userDoc = await admin.firestore().collection('Users').doc(receiverId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      return res.status(404).json({ error: 'FCM token not found for user' });
    }

    // Send a data-only FCM message (no notification field).
    // Data-only messages are always delivered to the app's message handler,
    // even when the app is in the background or killed.
    const message = {
      token: fcmToken,
      data: {
        type: 'incoming_call',
        callId: callId,
        callerName: callerName || 'Unknown',
        callType: callType || 'voice',
        callerId: callerId || '',
        callerEmail: callerEmail || '',
      },
      android: {
        priority: 'high',
        ttl: 60 * 1000, // 60 seconds TTL
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`📲 FCM sent to ${receiverId}: ${response}`);
    
    res.json({ success: true, messageId: response });
  } catch (err) {
    console.error('❌ FCM send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check endpoint ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    server: 'ChatX Signaling Server',
    activeUsers: userSocketMap.size,
    uptime: process.uptime(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: userSocketMap.size });
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`\n🚀 ChatX Signaling Server running on port ${PORT}`);
  console.log(`   Socket.IO: ws://localhost:${PORT}`);
  console.log(`   HTTP:      http://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health\n`);
});
