# Field Notes

A clean, notebook-style multi-user notes app. Users can create an account, log in, pin text and images, and see only their own notes.

## Run locally

Requirements: Node.js 18+

```bash
npm start
```

Open `http://localhost:3000`.

## How storage works

- `data/users.json` stores account records with salted password hashes.
- `data/users/<username>/notes/` stores each user's `.txt` notes.
- `data/users/<username>/uploads/` stores that user's images.
- The browser receives an HttpOnly session cookie; note API routes identify the user from that session.
- Text filenames use the first word of the note. Duplicate names become `Word-2.txt`, `Word-3.txt`, etc.

## GitHub

Push this folder to a GitHub repository. Do not commit `data/users.json` or `data/users/`; they are ignored by `.gitignore`.

GitHub is source-code hosting. To make the app available to other people, deploy the Node.js server on a service that supports Node and persistent storage/volumes. If the host has ephemeral storage, user files can disappear on restart/redeploy.

## Important deployment note

This project is intentionally simple for learning. Before using it for sensitive/private information, add production-grade authentication/session storage, HTTPS, rate limiting, CSRF protection as appropriate, persistent database/object storage, backups, and stronger account policies.
