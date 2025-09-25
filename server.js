// backend/server.js - Updated to properly handle all users with online/offline status
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

// -------------------- File Upload --------------------
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
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|mp4|mp3|zip/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      url: `/uploads/${req.file.filename}`
    });
  } catch {
    res.status(500).json({ error: 'File upload failed' });
  }
});

// -------------------- Routes --------------------
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Private Chat App Server Running!' });
});

// -------------------- User Management --------------------
const userSocketMap = new Map();
const userRooms = new Map();

// Helper function to get all users with their online status
const getAllUsersWithStatus = async () => {
  try {
    const allUsers = await User.find({}, 'username isOnline lastSeen').lean();
    return allUsers.map(user => ({
      id: user._id.toString(),
      username: user.username,
      isOnline: user.isOnline || false,
      lastSeen: user.lastSeen,
      socketId: userSocketMap.get(user._id.toString()) || null
    }));
  } catch (error) {
    console.error('Error fetching all users:', error);
    return [];
  }
};

// Helper function to broadcast all users to all connected clients
const broadcastAllUsers = async () => {
  const allUsers = await getAllUsersWithStatus();
  io.emit('allUsers', allUsers);
};

// -------------------- Socket Auth --------------------
const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error('Authentication error'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Authentication error'));
  }
};
io.use(socketAuth);

// Helper to create private room name
const getPrivateRoomName = (user1, user2) =>
  [user1, user2].sort().join('-private');

// -------------------- Socket.io --------------------
io.on('connection', async (socket) => {
  console.log(`User ${socket.user.username} connected`);

  try {
    // Update user status to online
    await User.findByIdAndUpdate(socket.user._id, {
      isOnline: true,
      socketId: socket.id,
      lastSeen: new Date(),
    });

    // Store user socket mapping
    userSocketMap.set(socket.user._id.toString(), socket.id);
    userRooms.set(socket.id, new Set());

    // Broadcast updated user list to all connected clients
    await broadcastAllUsers();

    // -------------------- Join Private Chat --------------------
    socket.on('joinPrivateChat', async ({ targetUserId }) => {
      try {
        const privateRoomName = getPrivateRoomName(socket.user._id.toString(), targetUserId);
        socket.join(privateRoomName);

        const rooms = userRooms.get(socket.id) || new Set();
        rooms.add(privateRoomName);
        userRooms.set(socket.id, rooms);

        const recent = await PrivateMessage.find({
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
          messages: recent.reverse(),
          isPrivate: true,
          targetUserId
        });
      } catch (err) {
        console.error('joinPrivateChat error:', err);
        socket.emit('error', { message: 'Failed to join private chat' });
      }
    });

    // -------------------- Send Message --------------------
    socket.on('sendMessage', async ({ content, targetUserId, fileData, messageType = 'text' }) => {
      try {
        if (!targetUserId) return socket.emit('error', { message: 'Target user required' });
        if (messageType === 'text') {
          if (!content || !content.trim()) return;
          if (content.length > 1000) return socket.emit('error', { message: 'Message too long' });
        }

        const privateMessage = new PrivateMessage({
          content: messageType === 'text' ? content.trim() : undefined,
          sender: socket.user._id,
          receiver: targetUserId,
          messageType,
          fileData: fileData || null,
        });

        const saved = await privateMessage.save();
        await saved.populate('sender', 'username');
        await saved.populate('receiver', 'username');

        const msg = {
          id: saved._id,
          content: saved.content,
          messageType: saved.messageType,
          fileData: saved.fileData,
          senderId: socket.user._id.toString(),
          receiverId: targetUserId,
          senderUsername: socket.user.username,
          receiverUsername: saved.receiver.username,
          createdAt: saved.createdAt,
          isPrivate: true,
        };

        const room = getPrivateRoomName(socket.user._id.toString(), targetUserId);
        io.to(room).emit('message', msg);

      } catch (err) {
        console.error('sendMessage error:', err);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // -------------------- Mark as Read --------------------
    socket.on('markAsRead', async ({ messageId }) => {
      try {
        const updated = await PrivateMessage.findByIdAndUpdate(
          messageId,
          { $addToSet: { readBy: { user: socket.user._id, readAt: new Date() } } },
          { new: true }
        ).populate('sender receiver', 'username');

        if (updated) {
          const room = getPrivateRoomName(updated.sender._id.toString(), updated.receiver._id.toString());
          io.to(room).emit('messageRead', updated);
        }
      } catch (err) {
        console.error('markAsRead error:', err);
      }
    });

    // -------------------- Edit Message --------------------
    socket.on('editMessage', async ({ messageId, newContent }) => {
      try {
        const updated = await PrivateMessage.findByIdAndUpdate(
          messageId,
          { content: newContent, edited: true, editedAt: new Date() },
          { new: true }
        ).populate('sender receiver', 'username');

        if (updated) {
          const room = getPrivateRoomName(updated.sender._id.toString(), updated.receiver._id.toString());
          io.to(room).emit('messageEdited', updated);
        }
      } catch (err) {
        console.error('editMessage error:', err);
      }
    });

    // -------------------- Typing Indicators --------------------
    socket.on('typing', ({ targetUserId }) => {
      if (!targetUserId) return;
      const room = getPrivateRoomName(socket.user._id.toString(), targetUserId);
      socket.broadcast.to(room).emit('typing', { userId: socket.user._id, username: socket.user.username, room });
    });

    socket.on('stopTyping', ({ targetUserId }) => {
      if (!targetUserId) return;
      const room = getPrivateRoomName(socket.user._id.toString(), targetUserId);
      socket.broadcast.to(room).emit('stopTyping', { userId: socket.user._id, username: socket.user.username, room });
    });

    // -------------------- Get All Users --------------------
    socket.on('getAllUsers', async () => {
      const allUsers = await getAllUsersWithStatus();
      socket.emit('allUsers', allUsers);
    });

    // -------------------- Disconnect --------------------
    socket.on('disconnect', async () => {
      console.log(`User ${socket.user.username} disconnected`);
      try {
        await User.findByIdAndUpdate(socket.user._id, {
          isOnline: false,
          socketId: null,
          lastSeen: new Date(),
        });

        userSocketMap.delete(socket.user._id.toString());
        userRooms.delete(socket.id);

        // Broadcast updated user list after disconnect
        await broadcastAllUsers();
      } catch (err) {
        console.error('disconnect error:', err);
      }
    });

  } catch (err) {
    console.error('connection error:', err);
    socket.disconnect();
  }
});

// -------------------- MongoDB --------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// -------------------- Graceful Shutdown --------------------
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await User.updateMany(
    { isOnline: true },
    { isOnline: false, socketId: null, lastSeen: new Date() }
  );
  await mongoose.connection.close();
  server.close(() => process.exit(0));
});

// -------------------- Chat History API --------------------
app.get('/api/chat-history/:userId', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
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
      .populate('receiver', 'username')
      .lean();

    res.json({ messages: messages.reverse() });
  } catch (err) {
    console.error('chat-history error:', err);
    res.status(500).json({ error: 'Failed to get chat history' });
  }
});

// -------------------- Get All Users API --------------------
app.get('/api/users', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    jwt.verify(token, process.env.JWT_SECRET);
    const allUsers = await getAllUsersWithStatus();
    res.json({ users: allUsers });
  } catch (err) {
    console.error('get users error:', err);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

