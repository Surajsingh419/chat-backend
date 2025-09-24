// backend/server.js - Private Chat with Read/Edited Support
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

// -------------------- Online Users --------------------
const onlineUsers = new Map();
const userRooms = new Map();
const userSocketMap = new Map();

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
    await User.findByIdAndUpdate(socket.user._id, {
      isOnline: true,
      socketId: socket.id,
      lastSeen: new Date(),
    });

    onlineUsers.set(socket.user._id.toString(), {
      id: socket.user._id,
      username: socket.user.username,
      socketId: socket.id,
      isOnline: true,
      lastSeen: new Date(),
    });
    userSocketMap.set(socket.user._id.toString(), socket.id);
    userRooms.set(socket.id, new Set());

    io.emit('onlineUsers', Array.from(onlineUsers.values()));

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

        // ✅ Only one emit (no duplicate)
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

    // -------------------- Disconnect --------------------
    socket.on('disconnect', async () => {
      console.log(`User ${socket.user.username} disconnected`);
      try {
        await User.findByIdAndUpdate(socket.user._id, {
          isOnline: false,
          socketId: null,
          lastSeen: new Date(),
        });

        // ✅ Update instead of delete
        onlineUsers.set(socket.user._id.toString(), {
          id: socket.user._id,
          username: socket.user.username,
          socketId: null,
          isOnline: false,
          lastSeen: new Date(),
        });
        userSocketMap.delete(socket.user._id.toString());
        userRooms.delete(socket.id);

        io.emit('onlineUsers', Array.from(onlineUsers.values()));
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

