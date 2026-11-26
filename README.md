# Fuel Token Tracker

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/YOUR_GITHUB_USERNAME/fuel-token-tracker)

A lightweight web app for tracking weekly petrol subsidy tokens across multiple bikes.

A new token can be collected exactly **7 days** after the previous one. When you own several bikes, each with its own schedule and SIM number, it is easy to lose track. This app keeps every bike in one list, sorted by whichever token is due soonest.

## Features

- **Separate logins**: every user signs in with their own username and password and only sees their own bikes. An **admin** sees everyone's bikes, adds users, resets passwords and can turn accounts off
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
- Mobile-first layout
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
| `server.js` | Express server, REST API and MongoDB models |
| `auth.js` | Password hashing, login cookies, rate limit |
| `manifest.webmanifest`, `sw.js`, `icon-*.png`, `apple-touch-icon.png` | Install-as-app files |
| `parser.js` | Reads token SMS text (bike number, token, dates, amount) |
| `parser.test.js` | Parser tests, run with `npm test` |
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
   - `APP_USER` and `APP_PASSWORD`: the first admin account
   - `SESSION_SECRET`: generated for you
4. Click **Deploy app**, then **View**, and sign in as the admin.

Before using the button, replace `YOUR_GITHUB_USERNAME` in this file and in `app.json` with your GitHub username. The repository must be public for the button to work.

## Users and logins

- On every start the admin account follows `APP_USER` / `APP_PASSWORD`: it is created if missing, and if you change `APP_PASSWORD` the password is reset to the new value. Bikes saved before accounts existed are given to this admin.
- Admin: tap your name at the top, then **Manage users** to add users, reset passwords, make someone admin, turn an account off, or delete it (only when it has no bikes).
- Each user adds and sees only their own bikes. The admin can add a bike for any user and filter the list by user.
- A bike number can exist only once across all accounts.
- Changing a password signs that account out on other devices.
- After 6 wrong passwords, sign-in is paused for 15 minutes for that username and address.
- If the admin password is lost, set a new `APP_PASSWORD` in the config vars; the app restarts and resets it.

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
| `APP_USER` | Every start | Username of the first admin (default `admin`) |
| `APP_TZ_OFFSET_MIN` | No | Minutes from UTC for times in the SMS (default `300`, Pakistan) |
| `APP_PASSWORD` | Every start | Admin password; changing it resets the admin's password |
| `SESSION_SECRET` | Yes | Long random string for signing login cookies |

## API

All `/api` routes except `login` need a signed-in user. Regular users only reach their own bikes.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/login` | Sign in (`username`, `password`) |
| `POST` | `/api/logout` | Sign out |
| `GET` | `/api/me` | Current user |
| `PUT` | `/api/me/password` | Change own password (`current`, `next`) |
| `GET` `POST` | `/api/users` | Admin: list / add users |
| `PUT` `DELETE` | `/api/users/:id` | Admin: edit, reset password, turn off, delete |
| `GET` | `/api/bikes` | List bikes, soonest token first |
| `POST` | `/api/bikes` | Add a bike (`number`, `name`, `sim`, `lastTokenAt`, admin: `owner`) |
| `PUT` | `/api/bikes/:id` | Update a bike |
| `POST` | `/api/bikes/:id/token` | Token collected: start the next cycle and wait for the SMS |
| `POST` | `/api/parse` | Preview what is read from a pasted SMS (`message`) |
| `POST` | `/api/bikes/:id/tokens` | Save a token from a pasted SMS (`message`, optional `force`) |
| `DELETE` | `/api/bikes/:id/tokens/:tokenId` | Delete a saved token |
| `DELETE` | `/api/bikes/:id` | Delete a bike |

## License

MIT
