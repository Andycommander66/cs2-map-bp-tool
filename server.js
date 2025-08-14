const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 存储房间信息
const rooms = {};

// 生成唯一房间ID
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// 静态文件服务
app.use(express.static('public'));

// 处理Socket连接
io.on('connection', (socket) => {
    console.log('新客户端连接:', socket.id);
    
    // 创建房间
    socket.on('createRoom', (username) => {
        const roomId = generateRoomId();
        
        // 创建新房间
        rooms[roomId] = {
            id: roomId,
            host: socket.id,
            users: {
                [socket.id]: {
                    id: socket.id,
                    username,
                    role: 'host',
                    team: 'team1' // 创建者加入队伍A
                }
            },
            state: {
                currentPhase: 'player-selection',
                diceRolled: false,
                diceResults: { team1: 0, team2: 0 },
                selectionOrder: null,
                lastToPick: null,
                firstHandTeam: null,
                secondHandTeam: null,
                currentSelector: null,
                selectedPlayers: { 
                    team1: [username + " (队长)"], 
                    team2: ["等待队员加入..."] 
                },
                availablePlayers: [
                    "队员1", "队员2", "队员3", "队员4", 
                    "队员5", "队员6", "队员7", "队员8"
                ],
                selectedPlayer: null,
                currentStep: 0,
                bannedMaps: [],
                selectedMaps: {
                    map1: null,
                    map2: null,
                    map3: null
                },
                campChoices: {
                    map1: { team: null, choice: null },
                    map2: { team: null, choice: null }
                },
                selectedMap: null
            }
        };
        
        // 加入房间
        socket.join(roomId);
        
        // 存储用户的房间信息
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.data.role = 'host';
        socket.data.team = 'team1'; // 记录用户所属队伍
        
        // 通知客户端房间已创建
        socket.emit('roomCreated', { roomId });
        
        // 更新房间内用户列表
        updateUserList(roomId);
    });
    
    // 加入房间
    socket.on('joinRoom', ({ roomId, username }) => {
        // 检查房间是否存在
        if (!rooms[roomId]) {
            socket.emit('error', '房间不存在');
            return;
        }
        
        // 检查房间是否已满（最多2人）
        if (Object.keys(rooms[roomId].users).length >= 2) {
            socket.emit('error', '房间已满');
            return;
        }
        
        // 加入房间
        socket.join(roomId);
        
        // 确定加入者的队伍（自动分配到队伍B）
        const userTeam = 'team2';
        
        // 存储用户的房间信息
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.data.role = 'player';
        socket.data.team = userTeam; // 记录用户所属队伍
        
        // 添加用户到房间
        rooms[roomId].users[socket.id] = {
            id: socket.id,
            username,
            role: 'player',
            team: userTeam // 加入者分配到队伍B
        };
        
        // 更新队伍B队长信息
        rooms[roomId].state.selectedPlayers.team2 = [username + " (队长)"];
        
        // 通知客户端成功加入房间
        socket.emit('roomJoined', { roomId, team: userTeam });
        
        // 通知房间内其他用户有新用户加入
        socket.to(roomId).emit('userJoined', { username, team: userTeam });
        
        // 更新房间内用户列表
        updateUserList(roomId);
        
        // 同步当前房间状态给新加入的用户
        socket.emit('updateState', rooms[roomId].state);
        
        // 向房间内所有用户广播更新后的状态
        io.to(roomId).emit('updateState', rooms[roomId].state);
    });
    
    // 发送消息
    socket.on('sendMessage', (message) => {
        const { roomId, username } = socket.data;
        
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('newMessage', {
                username,
                message
            });
        }
    });
    
    // 更新状态
    socket.on('updateState', (newState) => {
        const { roomId } = socket.data;
        
        if (roomId && rooms[roomId]) {
            // 任何用户都可以更新状态，只要是他们的回合
            rooms[roomId].state = newState;
            io.to(roomId).emit('updateState', newState);
        }
    });
    
    // 断开连接处理
    socket.on('disconnect', () => {
        console.log('客户端断开连接:', socket.id);
        const { roomId, username, team } = socket.data;
        
        if (roomId && rooms[roomId]) {
            // 通知房间内其他用户有用户离开
            socket.to(roomId).emit('userLeft', { username });
            
            // 移除用户
            delete rooms[roomId].users[socket.id];
            
            // 如果是房主离开，需要重新分配房主
            if (socket.id === rooms[roomId].host) {
                const remainingUsers = Object.keys(rooms[roomId].users);
                
                if (remainingUsers.length > 0) {
                    // 分配新房主
                    const newHostId = remainingUsers[0];
                    rooms[roomId].host = newHostId;
                    rooms[roomId].users[newHostId].role = 'host';
                    
                    // 更新新房主的队伍信息
                    rooms[roomId].users[newHostId].team = team === 'team1' ? 'team2' : 'team1';
                    
                    // 通知新房主
                    io.to(newHostId).emit('newHost', {
                        username: rooms[roomId].users[newHostId].username
                    });
                } else {
                    // 房间内没有用户了，删除房间
                    delete rooms[roomId];
                    return;
                }
            }
            
            // 更新房间内用户列表
            updateUserList(roomId);
        }
    });
});

// 更新房间内用户列表
function updateUserList(roomId) {
    if (rooms[roomId]) {
        io.to(roomId).emit('updateUsers', rooms[roomId].users);
    }
}

// 启动服务器
const PORT = process.env.PORT || 4900;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
    