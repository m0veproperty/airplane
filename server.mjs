import { createServer } from 'node:http';
import handler from './api/replay.mjs';

const port = Number(process.env.PORT || 3000);
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(error => {
    console.error(error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    if (!res.writableEnded) res.end('Internal replay error');
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Aero exact replay listening on ${port}`);
});
