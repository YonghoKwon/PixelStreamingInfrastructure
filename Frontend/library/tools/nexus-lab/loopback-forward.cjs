// Test-only TCP forwarding. Keep the same registry authority on Windows and
// isolated Docker clients so Nexus metadata never alternates public/internal URLs.
const net = require('node:net');
net.createServer(socket => {
  const upstream = net.connect(8081, 'nexus');
  socket.pipe(upstream); upstream.pipe(socket);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}).listen(48081, '127.0.0.1', () => console.log('Local test registry forwards only to nexus:8081'));
