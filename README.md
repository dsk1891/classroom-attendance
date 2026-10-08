# Classroom Attendance

An attendance app built with HTML, CSS, and JavaScript. Student phones scan a session QR and check in using their MIS number.

## Publish on Netlify

Deploy the **project root** using a Git-connected Netlify site or the Netlify CLI. Do not drag-and-drop only the `public` folder: that publishes the static pages but not the attendance API.

1. Put this whole project in a Git repository and push it to GitHub, GitLab, or Bitbucket.
2. In Netlify, select **Add new site → Import an existing project** and connect that repository.
3. In **Site configuration → Environment variables**, add `TEACHER_PASSWORD` with a unique password of at least 12 characters. Do not commit the password.
4. Leave the build command blank and set the publish directory to `public` (these are also set in `netlify.toml`).
5. Deploy the site. Netlify deploys `netlify/functions/api.mjs` as the API and uses Netlify Blobs to persist the roster and attendance history between function requests and deployments.
6. Open the deployed HTTPS site, enter the teacher password, add students, start a session, and display the QR code. Students can scan it from any network with internet access.

The `netlify.toml`, `netlify/functions/api.mjs`, `package.json`, and `package-lock.json` files are required for the Netlify deployment. The Blobs store is attached to the Netlify site; keep the same Netlify site when redeploying to keep its data.

## Run locally on Windows

Double-click `start.bat`, or run `npm install` then `npm start`. Open `http://localhost:3001`. The batch launcher sets the teacher password to `Admin#1234`; use it to unlock the dashboard. For direct `npm start`, set `TEACHER_PASSWORD` in the shell first. Keep the server running and allow Node.js through the firewall if prompted.

The local server stores data in `data/attendance.json`. Local server data and Netlify Blobs are separate stores. Export reports before moving sites; existing local attendance history is not automatically uploaded to Netlify.

## Features

- Add, remove, and CSV-import students with name, MIS number, and department
- Display a session QR code for student phone check-in by MIS number
- See check-ins update on the teacher dashboard
- End sessions and download attendance reports as CSV

MIS numbers identify students; they are not passwords. Student check-in is intentionally available to anyone with the active QR and a roster MIS number. Protect the teacher password, and only deploy student data to a site you control. This is a classroom/demo app, not a secured student information system.
