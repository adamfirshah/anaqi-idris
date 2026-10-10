# Anaqi Idris's Milk Tracker

A private family app for tracking Anaqi Idris's feeding, health, and daily care. Family members can record updates from different devices and see them sync in real time.

## Version
-Anaqi Idris 1.4

## Features

- Log formula milk (FM) and expressed breast milk (EBM)
- Add missed feeds with their original time
- Track direct feeding, poop, and Appeton
- Monitor daily totals, feeding intervals, and history
- Record Mummy's pumping sessions
- Store growth measurements and appointments
- Sync family activity across devices with Supabase
- Join a family using a private invite code
- Receive feeding and pumping reminders
- Install the app as a PWA on supported devices

## Built with

- React 19 and TypeScript
- Vite
- Supabase Authentication, Database, Realtime, and Edge Functions
- Firebase Cloud Messaging
- Vite PWA

## Local development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

Add your Supabase and Firebase credentials to `.env`:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_VAPID_KEY=
```

Never commit private credentials or service-role keys.

### 3. Configure Supabase

This app requires an existing Supabase project with its core family and feeding tables. Run the required files from `supabase/` in the Supabase SQL Editor for the features you use.

Important setup files include:

- `supabase/extra.sql` — family creation
- `supabase/join_family_by_code.sql` — invite-code joining
- `supabase/feedings_policies.sql` — feeding access policies and retrieval
- Other SQL files in `supabase/` — pumping, appointments, measurements, reminders, and activity logs

Enable anonymous sign-ins in Supabase under **Authentication → Providers → Anonymous** so invited family members can join without creating an account.

### 4. Start the app

```bash
npm run dev
```

Open `http://localhost:5173`.

To access the development app from another device on the same network:

```bash
npm run dev -- --host
```

## Available commands

```bash
npm run dev      # Start the development server
npm run build    # Type-check and create a production build
npm run lint     # Run Oxlint
npm run preview  # Preview the production build
```

## Production

Set the same environment variables on your hosting provider before deploying. The app can be deployed to any platform that supports a Vite static build.

Because this application contains private family information, keep the Supabase Row Level Security policies enabled and do not share invite codes publicly.
