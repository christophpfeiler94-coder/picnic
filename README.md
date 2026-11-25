# Basket

Shop your Picnic groceries from any browser on your phone or computer.

- **Search** Picnic's products and add them straight to your real Picnic cart.
- **Shopping list:** paste a list like `2 Milch`, `Bananen`, `6 Eier`, pick the right product for each line, and add them all at once.
- **Delivery:** choose a delivery time. Basket shows Picnic's minimum order and the order deadline.
- **Picnic look:** the colours, font and shapes follow picnic.app (red #e1171e, green #88a91e, warm beige panels, Roboto).
- **Pay in the app:** open the Picnic app, where your cart and delivery time are already set, and pay there. Basket never places or pays for an order.

> Basket is a personal tool. It is not made by, supported by or connected to Picnic. It uses the same private API as the Picnic app. The routes come from open-source projects such as python-picnic-api2 and the Home Assistant Picnic integration. Picnic can change this API at any time, and Basket may then stop working until it is updated.

## How it works

```
Your browser  ──►  Basket server (/api)  ──►  Picnic's app API
(web page)         holds no data              storefront-prod.de.picnicinternational.com
```

- You log in with your Picnic email and password. Picnic then sends an SMS code, which you enter once.
- The server sends your password to Picnic and does not store it. It keeps only Picnic's login token, encrypted (AES-256-GCM) in an HttpOnly cookie in your browser. You stay logged in for up to 180 days, or until Picnic ends the session.
- The server itself stores nothing, so it also runs on Vercel's free plan.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18.17 or newer. There is nothing to install.

```bash
cp .env.example .env      # then put a random SESSION_SECRET in .env
npm start                 # open http://localhost:3000
```

To get a random secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To use Basket from your phone at home, open `http://<your-computer's-IP>:3000` on the same Wi-Fi.

### Try it without a Picnic account

```bash
npm run demo              # open http://localhost:3000
```

This runs Basket against a pretend Picnic with sample products. Log in with any email and the password `demo`. The SMS code is `123456`.

## Put it online with Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new). Keep the framework preset set to **Other**, with no build command.
2. Under **Environment Variables**, add `SESSION_SECRET` with a random value (see above). Optionally add `PICNIC_COUNTRY` (default `de`).
3. Deploy, then open the address on your phone. Add it to your home screen if you like.

Only someone with your Picnic password and your phone (for the SMS code) can log in to Picnic. You can also put a Google sign-in in front, see below.

## Google sign-in (optional)

With Google sign-in switched on, Basket first asks for a Google account and only lets in the addresses in `ALLOWED_EMAILS`. Anyone else is stopped before they reach the Picnic login.

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials). Create a project if you have none.
2. If asked, set up the **OAuth consent screen**: type "External", app name "Basket", your email as support and developer contact. Add your Gmail address under **Test users**. Only the `openid` and `email` scopes are needed.
3. **Create credentials → OAuth client ID**, type **Web application**.
4. Under **Authorized redirect URIs** add `https://<your-basket-address>/api/auth/callback`, for example `https://picnic-basket-christophpfeiler94-coders-projects.vercel.app/api/auth/callback`.
5. Copy the **Client ID** and **Client secret** into the Vercel settings below, then redeploy.

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Client ID (switching Google sign-in on) |
| `GOOGLE_CLIENT_SECRET` | the Client secret |
| `ALLOWED_EMAILS` | the Google addresses that may use Basket, separated by commas |
| `APP_URL` | optional: the site address, if Google complains about the redirect address |

You stay signed in with Google for 30 days. "Log out" signs you out of Google and Picnic in Basket.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SESSION_SECRET` | none (required) | Encrypts the login cookie. If you change it, you have to log in again. |
| `PICNIC_COUNTRY` | `de` | Picnic country: `de`, `nl`, `be` or `fr`. |
| `PICNIC_API_VERSION` | `15` | Picnic API version in the URL. |
| `PORT` | `3000` | Port for `npm start`. |
| `PICNIC_BASE_URL` | built from the country | Full API address. Only for testing. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, `APP_URL` | not set | Google sign-in, see above. |

## Tests

```bash
npm test
```

The tests run the whole flow against the pretend Picnic: login, SMS code, search, cart changes, the shopping list, delivery times and logout. They also check that the cookie can't be read or forged, and that Google sign-in lets in only allowed accounts.

## Files

| Path | What it is |
| --- | --- |
| `public/` | The web page (HTML, CSS, JavaScript, no build step) |
| `lib/picnic.js` | Talks to Picnic's API |
| `lib/api.js` | The page's API: `/api/login`, `/api/search`, `/api/cart/...`, `/api/slots/...` |
| `lib/session.js` | Encrypted login cookie |
| `lib/gate.js` | Optional Google sign-in |
| `lib/normalize.js` | Turns Picnic's answers into simple data for the page |
| `server.js` | Local server (`npm start`) |
| `api/handler.js`, `vercel.json` | Vercel setup |
| `dev/mock-picnic.js`, `dev/demo.js` | Pretend Picnic for the demo and the tests |

## If something breaks

- **"Picnic did not accept this email and password":** check them in the Picnic app.
- **Search finds nothing or shows an error after an update of the Picnic app:** Picnic probably changed its API. Look for changes in the open-source Picnic clients linked above and update `lib/picnic.js`.
- **You get logged out:** Picnic ended the session. Log in again, including the SMS code.
