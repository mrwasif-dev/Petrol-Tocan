# Fuel Token Tracker

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/YOUR_GITHUB_USERNAME/fuel-token-tracker)

A lightweight web app for tracking weekly petrol subsidy tokens across multiple bikes.

A new token can be collected exactly **7 days** after the previous one. When you own several bikes, each with its own schedule and SIM number, it is easy to lose track. This app keeps every bike in one list, sorted by whichever token is due soonest.

## Features

- **Bikes are identified by bike number** (e.g. `0786` or `MNR-14-1038`). Each number is unique.
- Each bike also stores the owner's **name** and the **SIM number** the token is sent to
- After **Token collected**, an **Add Token** button appears on the bike card
- **Add Token**: paste the full SMS and the system reads the bike number, token number, issue time, expiry, next token time and relief amount by itself
- Works with both SMS formats (token issued notice, and "fuel relief of 500 rupees" notice), Urdu or English digits
- If the SMS belongs to a different bike, you are warned and can save it to the matching bike
- Duplicate tokens are rejected
- **Details** view: token ticket, bike and owner info, full token history, original SMS, and **copy buttons** (token, bike number, SIM, or all details at once)
- Next token time comes from the token's expiry in the SMS (7 days after issue)
- Live countdown, status (**Token ready**, **Due soon**, **Waiting**), search and filters
- Mobile-first layout, optional password protection (HTTP Basic Auth)
- **Installable as an app** (PWA): home-screen icon, full-screen window, works as a shell when offline

## Install on a phone

Open the deployed (HTTPS) address, then:

- **Android / Chrome**: tap **Install app** at the top of the page (or menu, then *Install app*)
- **iPhone / Safari**: Share button, then **Add to Home Screen**

## Tech stack

Node.js, Express, MongoDB (Mongoose), plain HTML/CSS/JavaScript front end.

## Project structure

All files live in the repository root:

| File | Purpose |
| --- | --- |
| `server.js` | Express server, REST API and MongoDB model |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install-as-app files |
| `parser.js` | Reads token SMS text (bike number, token, dates, amount) |
| `test/parser.test.js` | Parser tests, run with `npm test` |
| `index.html` | Complete front end (HTML, CSS and JavaScript) |
| `package.json` | Dependencies and start script |
| `Procfile` | Heroku process definition |
| `app.json` | Heroku Deploy button configuration |
| `.env.example` | Example environment variables |

## Deploy to Heroku

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas) and copy its connection string. In Atlas, allow network access from anywhere (`0.0.0.0/0`) so Heroku can connect.
2. Click the **Deploy to Heroku** button above.
3. Fill in the config vars:
   - `MONGODB_URI`: your Atlas connection string
   - `APP_USER`: the username you will sign in with
   - `APP_PASSWORD`: a strong password
4. Click **Deploy app**, then **View**.

Before using the button, replace `YOUR_GITHUB_USERNAME` in this file and in `app.json` with your GitHub username. The repository must be public for the button to work.

## Run locally

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/fuel-token-tracker.git
cd fuel-token-tracker
cp .env.example .env     # then edit MONGODB_URI
npm install
npm start
```

Open http://localhost:3000.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `PORT` | No | Local port (Heroku sets it automatically) |
| `APP_USER` | No | Sign-in username (default `admin`) |
| `APP_TZ_OFFSET_MIN` | No | Minutes from UTC for times in the SMS (default `300`, Pakistan) |
| `APP_PASSWORD` | No | Enables sign-in when set. Strongly recommended for public deployments |

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/bikes` | List bikes, soonest token first |
| `POST` | `/api/bikes` | Add a bike (`number`, `name`, `sim`, `lastTokenAt`) |
| `PUT` | `/api/bikes/:id` | Update a bike |
| `POST` | `/api/bikes/:id/token` | Token collected: start the next cycle and wait for the SMS |
| `POST` | `/api/parse` | Preview what is read from a pasted SMS (`message`) |
| `POST` | `/api/bikes/:id/tokens` | Save a token from a pasted SMS (`message`, optional `force`) |
| `DELETE` | `/api/bikes/:id/tokens/:tokenId` | Delete a saved token |
| `DELETE` | `/api/bikes/:id` | Delete a bike |

## License

MIT
