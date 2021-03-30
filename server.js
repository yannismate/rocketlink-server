const {Server} = require('socket.io');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const Schema = require("validate");
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('port', {
    alias: 'p',
    description: 'Port the server should run on',
    type: 'number',
    default: 49123
  })
  .help()
  .alias('help', 'h')
    .argv;

//5 messages every 10 seconds on 'join' to prevent brute-forcing a lobby
const rateLimiter = new RateLimiterMemory({
      points: 5,
      duration: 10,
});

let lobbies = {};
/*lobbies = {
  lobbyName: {
    host: socketId1,
    players: [{socketId: "socketId1", playerId: "playerId1", playerName: "playerName1"}, {socketId: "socketId2", playerId: "playerId2", playerName: "playerName2"}],
    password: "secret",
    settings: {
      minDistance: 400,
      maxDistance: 6000,
      rolloffFactor: 1.2
    },
    bannedPlayerIds: []
  }
}*/

const VALIDATORS = {
  'lobby_create': new Schema({
    room: {required : true, type: String, length: {max: 64}},
    password: {required : true, type: String, length: {max: 64}},
    playerId: {required : true, type: String, length: {max: 64}},
    playerName: {required : true, type: String, length: {max: 64}},
    settings: {
      minDistance: {
        required: true,
        type: Number
      },
      maxDistance: {
        required: true,
        type: Number
      },
      rolloffFactor: {
        required: true,
        type: Number
      }
    }
  }),
  'lobby_join': new Schema({
    room: {required : true, type: String, length: {max: 64}},
    password: {required : true, type: String, length: {max: 64}},
    playerId: {required : true, type: String, length: {max: 64}},
    playerName: {required : true, type: String, length: {max: 64}}
  }),
  'lobby_update_settings': new Schema({
    minDistance: {
      required: true,
      type: Number
    },
    maxDistance: {
      required: true,
      type: Number
    },
    rolloffFactor: {
      required: true,
      type: Number
    }
  }),
  'lobby_kick_player': new Schema({
    playerId: {required : true, type: String, length: {max: 64}},
    ban: {required: true, type: Boolean}
  })

}

const server = new Server(argv.port);
console.log(`Started RocketLink server on port ${argv.port}`);

server.on('connection', (socket) => {
  console.log(`[${socket.handshake.address} - ${socket.id}] Connected`);

  socket.on('lobby_create', (data, ack) => {
    if(socket['lobby']) {
      ack({status: 'error', error: 'ALREADY_JOINED'});
      return;
    }
    if(VALIDATORS.lobby_create.validate(data).length > 0) {
      ack({status: 'error', error: 'BAD_REQUEST'});
    } else {
      if(lobbies[data['room']]) {
        ack({status: 'error', error: 'NAME_USED'});
      } else {
        rateLimiter.consume(socket.handshake.address, 1)
          .then(() => {
            lobbies[data['room']] = {
              host: socket.id,
              players: [{socketId: socket.id, playerId: data['playerId'], playerName: data['playerName']}],
              password: data['password'],
              settings: {
                minDistance: data['settings']['minDistance'],
                maxDistance: data['settings']['maxDistance'],
                rolloffFactor: data['settings']['rolloffFactor']
              },
              bannedPlayerIds: []
            }
            socket['lobby'] = data['room'];
            socket['playerId'] = data['playerId'];
            socket['playerName'] = data['playerName'];
            ack({status: 'ok'});
          }).catch(() => {
          ack({status: 'error', error: 'RATE_LIMIT_EXCEEDED'});
          });
      }
    }
  });

  socket.on('lobby_join', (data, ack) => {
    if(socket['lobby']) {
      ack({status: 'error', error: 'ALREADY_JOINED'});
      return;
    }
    if(VALIDATORS.lobby_join.validate(data).length > 0) {
      ack({status: 'error', error: 'BAD_REQUEST'});
    } else {
      rateLimiter.consume(socket.handshake.address, 1)
        .then(() => {
          if(lobbies[data['room']]) {
            if(lobbies[data['room']]['bannedPlayerIds'].includes(data['playerId'])) {
              ack({status: 'error', error: 'PLAYER_BANNED'});
              return;
            }
            if(lobbies[data['room']]['password'] === data['password']) {
              socket['lobby'] = data['room'];
              socket['playerId'] = data['playerId'];
              socket['playerName'] = data['playerName'];
              broadcastToLobby(data['room'], 'lobby_player_joined', {playerId: data['playerId'], playerName: data['playerName']});
              lobbies[data['room']]['players'].push({socketId: socket.id, playerId: data['playerId'], playerName: data['playerName']});
              const players = lobbies[data['room']]['players'].map(item => {
                return {playerId: item['playerId'], playerName: item['playerName']};
              });
              ack({status: 'ok', data: {settings: lobbies[data['room']]['settings'], players: players}});
            } else {
              ack({status: 'error', error: 'WRONG_PASSWORD'});
            }
          } else {
            ack({status: 'error', error: 'ROOM_NOT_FOUND'});
          }
        })
        .catch(() => {
          ack({status: 'error', error: 'RATE_LIMIT_EXCEEDED'});
        });
    }
  });

  socket.on('lobby_update_settings', (data, ack) => {
    if(!socket['lobby']) {
      ack({status: 'error', error: 'NO_LOBBY_FOUND'});
      return;
    }
    if(VALIDATORS.lobby_update_settings.validate(data).length > 0) {
      ack({status: 'error', error: 'BAD_REQUEST'});
    } else {
      if(lobbies[socket['lobby']]['host'] === socket.id) {
        lobbies[socket['lobby']]['settings'] = {
          minDistance: data['minDistance'],
          maxDistance: data['maxDistance'],
          rolloffFactor: data['rolloffFactor']
        };
        ack({status: 'ok'});
        broadcastToLobby(socket['lobby'], 'lobby_settings_changed', {settings: lobbies[socket['lobby']]['settings']});
      } else {
        ack({status: 'error', error: 'NO_PERMISSION'});
      }
    }
  });

  socket.on('lobby_kick_player', (data, ack) => {
    if(!socket['lobby']) {
      ack({status: 'error', error: 'NO_LOBBY_FOUND'});
      return;
    }
    if(VALIDATORS.lobby_kick_player.validate(data).length > 0) {
      ack({status: 'error', error: 'BAD_REQUEST'});
    } else {
      if(data['playerId'] === socket['playerId']) {
        //Can't ban/kick yourself
        ack({status: 'error', error: 'BAD_REQUEST'});
        return;
      }
      if(lobbies[socket['lobby']]['host'] === socket.id) {

        const kickedPlayer = lobbies[socket['lobby']]['players'].find(item => item['playerId'] === data['playerId']);

        if(kickedPlayer) {
          if(data['ban']) {
            lobbies[socket['lobby']]['bannedPlayerIds'].push(data['playerId']);
          }
          broadcastToLobby(socket['lobby'], 'lobby_player_disconnect', {playerId: kickedPlayer['playerId'], playerName: kickedPlayer['playerName'], reason: 'KICKED'});
          lobbies[socket['lobby']]['players'] = lobbies[socket['lobby']]['players'].filter(item => item['playerId'] !== data['playerId']);
          if(lobbies[socket['lobby']]['players'].length === 0) {
            delete lobbies[socket['lobby']];
            console.log(`Deleted empty lobby ${socket['lobby']}`);
          }
          delete server.sockets.sockets.get(kickedPlayer['socketId'])['lobby'];
          ack({status: 'ok'});
        } else {
          ack({status: 'error', error: 'PLAYER_NOT_FOUND'});
        }

      } else {
        ack({status: 'error', error: 'NO_PERMISSION'});
      }
    }
  });

  socket.on('lobby_leave', (data, ack) => {
    if(!socket['lobby']) {
      ack({status: 'error', error: 'NO_LOBBY_FOUND'});
      return;
    }
    broadcastToLobby(socket['lobby'], 'lobby_player_disconnect', {playerId: socket['playerId'], playerName: socket['playerName'], reason: 'disconnected'});
    lobbies[socket['lobby']]['players'] = lobbies[socket['lobby']]['players'].filter(item => item['playerId'] !== socket['playerId']);
    if(lobbies[socket['lobby']]['players'].length === 0) {
      delete lobbies[socket['lobby']];
      console.log(`Deleted empty lobby ${socket['lobby']}`);
    }
    delete socket['lobby'];
    ack({status: 'ok'});
  });

  socket.on("disconnecting", (reason) => {
    if(!socket['lobby']) {
      return;
    }
    broadcastToLobby(socket['lobby'], 'lobby_player_disconnect', {playerId: socket['playerId'], playerName: socket['playerName'], reason: 'disconnected'});
    lobbies[socket['lobby']]['players'] = lobbies[socket['lobby']]['players'].filter(item => item['playerId'] !== socket['playerId']);
    if(lobbies[socket['lobby']]['players'].length === 0) {
      delete lobbies[socket['lobby']];
      console.log(`Deleted empty lobby ${socket['lobby']}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${socket.handshake.address} - ${socket.id}] Disconnected (${reason})`);
  });

  socket.on('peer_signal', (data, ack) => {
    if(!socket['lobby']) {
      ack({status: 'error', error: 'NO_LOBBY_FOUND'});
      return;
    }

    //Cannot use validator here as it would delete the nested object

    if(!data['to'] || !data['data']) {
      ack({status: 'error', error: 'BAD_REQUEST'});
    } else {
      const recipient = lobbies[socket['lobby']]['players'].find(item => item['playerId'] === data['to']);
      if(recipient) {
        data['from'] = socket['playerId'];
        server.to(recipient['socketId']).emit('peer_signal', data);
      } else {
        ack({status: 'error', error: 'RECIPIENT_NOT_FOUND'});
      }
    }
  });


});

function broadcastToLobby(lobby, event, message) {
  if(!lobbies[lobby]) return;
  lobbies[lobby]['players'].forEach(player => {
    server.to(player['socketId']).emit(event, message);
  });
}