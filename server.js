// backend/server.js - Private Chat Only
require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const User = require('./models/user');
const PrivateMessage = require('./models/privateMessage');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'https://chat-frontend-fawn-mu.vercel.app',
  'http://localhost:3000'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

const io = require('socket.io')(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow images, documents, and other common files
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|mp4|mp3|zip/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// File upload route
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      url: `/uploads/${req.file.filename}`
    });
  } catch (error) {
    res.status(500).json({ error: 'File upload failed' });
  }
});

// Routes
app.use('/api/auth', authRoutes);

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Private Chat App Server Running!' });
});

// Store online users and their private chat rooms
const onlineUsers = new Map();
const typingUsers = new Map(); // Map for tracking typing in private chats
const userRooms = new Map(); // Track which private rooms users are in

// Socket authentication middleware
const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return next(new Error('Authentication error'));
    }

    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
};

// Apply socket authentication
io.use(socketAuth);

// Helper function to generate private room name
const getPrivateRoomName = (user1Id, user2Id) => {
  return [user1Id, user2Id].sort().join('-private');
};

// Socket.io connection handling
io.on('connection', async (socket) => {
  console.log(`User ${socket.user.username} connected for private chat`);

  try {
    // Update user status
    await User.findByIdAndUpdate(socket.user._id, {
      isOnline: true,
      socketId: socket.id,
      lastSeen: new Date(),
    });

    // Add to online users
    onlineUsers.set(socket.user._id.toString(), {
      id: socket.user._id,
      username: socket.user.username,
      socketId: socket.id,
    });

    // Initialize user rooms tracking
    userRooms.set(socket.id, new Set());

    // Broadcast updated online users to all
    const onlineUsersList = Array.from(onlineUsers.values());
    io.emit('onlineUsers', onlineUsersList);

    console.log(`User ${socket.user.username} is now online for private messaging`);

    // Handle joining private chat
    socket.on('joinPrivateChat', async (data) => {
      try {
        const { targetUserId } = data;
        const privateRoomName = getPrivateRoomName(socket.user._id.toString(), targetUserId);
        
        // Leave any existing private rooms first
        const currentRooms = userRooms.get(socket.id) || new Set();
        currentRooms.forEach(roomName => {
          socket.leave(roomName);
        });
        
        // Join the new private room
        socket.join(privateRoomName);
        userRooms.set(socket.id, new Set([privateRoomName]));

        // Get recent private messages between these two users
        const recentPrivateMessages = await PrivateMessage.find({
          $or: [
            { sender: socket.user._id, receiver: targetUserId },
            { sender: targetUserId, receiver: socket.user._id }
          ]
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate('sender', 'username')
        .populate('receiver', 'username')
        .lean();

        socket.emit('recentMessages', {
          room: privateRoomName,
          messages: recentPrivateMessages.reverse(),
          isPrivate: true,
          targetUserId
        });

        console.log(`User ${socket.user.username} joined private chat room: ${privateRoomName}`);
      } catch (error) {
        console.error('Join private chat error:', error);
        socket.emit('error', { message: 'Failed to join private chat' });
      }
    });

    // Handle sendMessage (private messages only)
    socket.on('sendMessage', async (data) => {
      try {
        const { content, targetUserId, fileData, messageType = 'text' } = data;
        
        if (!targetUserId) {
          socket.emit('error', { message: 'Target user is required for private messages' });
          return;
        }

        if (messageType === 'text' && (!content || content.trim().length === 0)) {
          return;
        }
        
        if (messageType === 'text' && content.length > 1000) {
          socket.emit('error', { message: 'Message too long' });
          return;
        }

        // Create private message
        const privateMessage = new PrivateMessage({
          content: messageType === 'text' ? content?.trim() : '',
          sender: socket.user._id,
          receiver: targetUserId,
          messageType,
          fileData: fileData || null,
        });

        const savedMessage = await privateMessage.save();
        await savedMessage.populate('sender', 'username');
        await savedMessage.populate('receiver', 'username');

        const messageData = {
          id: savedMessage._id,
          content: savedMessage.content,
          sender: {
            _id: socket.user._id,
            username: socket.user.username,
          },
          receiver: {
            _id: savedMessage.receiver._id,
            username: savedMessage.receiver.username,
          },
          messageType: savedMessage.messageType,
          fileData: savedMessage.fileData,
          createdAt: savedMessage.createdAt,
          isPrivate: true,
        };

        // Send to both users in the private room
        const privateRoomName = getPrivateRoomName(socket.user._id.toString(), targetUserId);
        io.to(privateRoomName).emit('message', messageData);

        console.log(`Private message sent between ${socket.user.username} and ${savedMessage.receiver.username}`);

      } catch (error) {
        console.error('Send private message error:', error);
        socket.emit('error', { message: 'Failed to send private message' });
      }
    });

    // Handle typing indicators for private chats
    socket.on('typing', (data) => {
      const { targetUserId } = data;
      
      if (!targetUserId) return;
      
      const privateRoomName = getPrivateRoomName(socket.user._id.toString(), targetUserId);
      
      if (!typingUsers.has(privateRoomName)) {
        typingUsers.set(privateRoomName, new Set());
      }
      
      const roomTyping = typingUsers.get(privateRoomName);
      const typingKey = `${socket.user._id}-${socket.user.username}`;
      
      if (!roomTyping.has(typingKey)) {
        roomTyping.add(typingKey);
        socket.broadcast.to(privateRoomName).emit('typing', {
          userId: socket.user._id,
          username: socket.user.username,
          room: privateRoomName,
        });
      }
    });

    socket.on('stopTyping', (data) => {
      const { targetUserId } = data;
      
      if (!targetUserId) return;
      
      const privateRoomName = getPrivateRoomName(socket.user._id.toString(), targetUserId);
      
      if (typingUsers.has(privateRoomName)) {
        const roomTyping = typingUsers.get(privateRoomName);
        const typingKey = `${socket.user._id}-${socket.user.username}`;
        
        if (roomTyping.has(typingKey)) {
          roomTyping.delete(typingKey);
          socket.broadcast.to(privateRoomName).emit('stopTyping', {
            userId: socket.user._id,
            username: socket.user.username,
            room: privateRoomName,
          });
        }
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`User ${socket.user.username} disconnected from private chat`);
      try {
        await User.findByIdAndUpdate(socket.user._id, {
          isOnline: false,
          socketId: null,
          lastSeen: new Date(),
        });

        onlineUsers.delete(socket.user._id.toString());

        // Clean up typing indicators for all private rooms this user was in
        const userSocketRooms = userRooms.get(socket.id) || new Set();
        userSocketRooms.forEach(roomName => {
          if (typingUsers.has(roomName)) {
            const roomTyping = typingUsers.get(roomName);
            const typingKey = `${socket.user._id}-${socket.user.username}`;
            roomTyping.delete(typingKey);
            
            // If no one is typing in this room anymore, clean it up
            if (roomTyping.size === 0) {
              typingUsers.delete(roomName);
            }
          }
        });

        userRooms.delete(socket.id);

        // Broadcast updated online users list
        const onlineUsersList = Array.from(onlineUsers.values());
        io.emit('onlineUsers', onlineUsersList);

        console.log(`User ${socket.user.username} removed from private chat system`);

      } catch (error) {
        console.error('Disconnect error:', error);
      }
    });

  } catch (error) {
    console.error('Socket connection error:', error);
    socket.disconnect();
  }
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => {
      console.log(`Private Chat Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down private chat server gracefully');
  await User.updateMany(
    { isOnline: true },
    { isOnline: false, socketId: null, lastSeen: new Date() }
  );
  await mongoose.connection.close();
  server.close(() => {
    console.log('Private chat server closed');
    process.exit(0);
  });
});

// Additional endpoint to get user's chat history with another user
app.get('/api/chat-history/:userId', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const currentUserId = decoded.id;
    const { userId: targetUserId } = req.params;

    const messages = await PrivateMessage.find({
      $or: [
        { sender: currentUserId, receiver: targetUserId },
        { sender: targetUserId, receiver: currentUserId }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('sender', 'username')
    .populate('receiver', 'username');

    res.json({ messages: messages.reverse() });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({ error: 'Failed to get chat history' });
  }
});