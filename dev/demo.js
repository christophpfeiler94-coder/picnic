// Runs the app against the pretend Picnic server, so you can try it without an account.
// npm run demo, then open http://localhost:3000 and log in with any email and the password "demo".
import { createMockPicnic } from './mock-picnic.js';
import { createAppServer } from '../server.js';

const mockPort = Number(process.env.MOCK_PORT) || 4010;
const port = Number(process.env.PORT) || 3000;
createMockPicnic({ require2fa: process.env.MOCK_2FA !== '0' }).server.listen(mockPort, () => {
  const base = `http://localhost:${mockPort}`;
  createAppServer({
    secret: 'demo-secret-demo-secret',
    config: { baseUrl: `${base}/api/15`, imageBase: `${base}/static/images`, agent: 'demo', deviceId: 'demo', clientId: 30100 },
  }).listen(port, () => {
    console.log(`Demo running at http://localhost:${port}`);
    console.log('Log in with any email and the password "demo". The SMS code is 123456.');
  });
});
