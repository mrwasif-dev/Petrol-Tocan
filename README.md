# Fuel Token Tracker

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/YOUR_GITHUB_USERNAME/fuel-token-tracker)

A lightweight web app for tracking weekly petrol subsidy tokens across multiple bikes.

A new token can be collected exactly **7 days** after the previous one. When you own several bikes, each with its own schedule and SIM number, it is easy to lose track. This app keeps every bike in one list, sorted by whichever token is due soonest.

## Features

- Each bike is identified by its **bike number**, shown as a number plate (for example `LEA-0786`)
- Store the SIM number the token is sent to, together with the SIM holder's name
- Next token time is calculated automatically (last token + 7 days)
- Bikes are sorted by the soonest upcoming token, with a live countdown and a 7-day gauge
- Clear status for each bike: **Token ready**, **Due soon** (within 24 hours) or **Waiting**
- One tap on **Token collected** starts the next 7-day cycle and reveals an **Add token** button
- **Add token**: paste the full message you received and the bike number and token number are picked out automatically, with a warning if the message belongs to a different bike
- **Details** view with the bike and SIM information, schedule, latest token, saved message and token history
- **Copy** buttons for the bike number, SIM number, token number, the original message and a full details summary
- Edit or delete bikes at any time
- Responsive layout built for phones
- Optional password protection (HTTP Basic Auth)

> The message reader uses pattern matching, so it works with most formats without any setup. Both detected values can be corrected by hand before saving.

## Tech stack

Node.js, Express, MongoDB (Mongoose), plain HTML/CSS/JavaScript front end.

## Project structure

All files live in the repository root:

| File | Purpose |
| --- | --- |
| `server.js` | Express server, REST API and MongoDB model |
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
| `APP_PASSWORD` | No | Enables sign-in when set. Strongly recommended for public deployments |

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/bikes` | List bikes, soonest token first |
| `POST` | `/api/bikes` | Add a bike (`bikeNumber`, `simName`, `simNumber`, `lastTokenAt`) |
| `PUT` | `/api/bikes/:id` | Update a bike |
| `POST` | `/api/bikes/:id/collect` | Mark a token as collected now and start the next cycle |
| `POST` | `/api/bikes/:id/tokens` | Save a token (`tokenNumber`, `bikeNumber`, `message`) |
| `DELETE` | `/api/bikes/:id/tokens/:tokenId` | Remove a saved token |
| `DELETE` | `/api/bikes/:id` | Delete a bike |

## License

MIT
