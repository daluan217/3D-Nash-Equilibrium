# Backend Deployment Guide: Google Cloud Run

This guide will help you deploy the Nash Equilibrium Simulator backend to Google Cloud Run (free tier available).

## Prerequisites

1. **Google Cloud Account** - Free tier includes: 2 million requests/month, 360,000,000 GB-seconds/month
2. **GitHub Account** - Your code is already there at `daluan217/3D-Nash-Equilibrium`
3. **Gmail Account** - For SMTP email verification (or any SMTP service)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top
3. Click **NEW PROJECT**
4. Name it `nash-equilibrium-simulator` (or your choice)
5. Click **CREATE**
6. Wait for the project to be created and select it

## Step 2: Enable Required APIs

In the Cloud Console, enable these APIs:
- Cloud Run API
- Cloud Build API
- Cloud Container Registry API

1. Click the **Activate Cloud Shell** button (terminal icon, top right)
2. Run these commands:

```bash
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

## Step 3: Set Up GitHub Connection for Cloud Build

1. Go to **Cloud Build** → **Repositories** in the Cloud Console
2. Click **CONNECT REPOSITORY**
3. Select **GitHub** as the source
4. Authorize Google Cloud to access your GitHub account
5. Select repository: `daluan217/3D-Nash-Equilibrium`
6. Click **CONNECT**

## Step 4: Create a Cloud Build Trigger

1. In **Cloud Build** → **Triggers**, click **CREATE TRIGGER**
2. Name: `deploy-backend`
3. Event: Select **Push to a branch**
4. Source: Select your connected repository
5. Branch: `^main$` (or your main branch)
6. Build configuration: Select **Cloud Build configuration file**
7. Cloud Build configuration file location: `/cloudbuild.yaml`
8. Click **CREATE**

## Step 5: Configure Environment Variables

Before your first build, set up the secrets:

1. Go to **Cloud Build** → **Triggers**
2. Click on your trigger name
3. Click **EDIT**
4. Scroll to **Substitutions** section
5. Add or update these variables:
   - `_SMTP_HOST`: `smtp.gmail.com`
   - `_SMTP_PORT`: `465`
   - `_SMTP_USER`: Your Gmail address
   - `_SMTP_PASS`: [Gmail App Password](#getting-a-gmail-app-password)
   - `_GEMINI_API_KEY`: Your Gemini API key
6. Click **SAVE**

### Getting a Gmail App Password

Since Gmail requires app-specific passwords for security:

1. Go to [Google Account Security Settings](https://myaccount.google.com/security)
2. Enable **2-Step Verification** if you haven't already
3. Go back to Security → **App passwords**
4. Select **Mail** and **Windows Computer** (or your device)
5. Google will generate a 16-character password
6. Copy this and use it as `_SMTP_PASS`

## Step 6: Deploy for the First Time

Option A: **Automatic (recommended)**
- Just push to your main branch:
  ```bash
  cd /Users/danielluan/Desktop/3D-Nash-Equilibrium
  git add Dockerfile .dockerignore cloudbuild.yaml
  git commit -m "Add deployment configuration"
  git push origin main
  ```
- Cloud Build will automatically build and deploy

Option B: **Manual**
1. In Cloud Console, go to **Cloud Build** → **Triggers**
2. Click your trigger
3. Click **RUN**
4. Monitor the build in the **Build history**

## Step 7: Find Your Deployment URL

Once deployed successfully:

1. Go to **Cloud Run** in the Cloud Console
2. Click on your service named `nash-equilibrium-backend`
3. At the top, you'll see a **Service URL** (looks like `https://nash-equilibrium-backend-xxxxx.run.app`)
4. Copy this URL

## Step 8: Test Your Backend

1. Open your browser and go to: `https://nash-equilibrium-backend-xxxxx.run.app/api/health`
2. You should see: `{"status":"ok"}`

## Step 9: Update Your Electron App

Now point your app to the new backend:

1. Open the Electron app
2. Go to Menu → Account Settings
3. Switch to **Cloud Sync Mode**
4. Enter your backend URL in **Central Hub Website URL**:
   ```
   https://nash-equilibrium-backend-xxxxx.run.app
   ```
5. Click **Test** to verify the connection
6. You should see: "Connection successful!"

## Step 10: Use Cloud Sync!

Now you can:
- Create accounts in the app or on the website
- Log in with the same account on both
- Save games and they'll sync to the cloud
- Access your games from any device with the app or website

## Troubleshooting

### Build fails with "Docker image not found"
- Wait 5-10 minutes after enabling Container Registry API
- Manually trigger the build again

### Cloud Run deployment times out
- Check the build logs in **Cloud Build** → **Build history**
- Look for error messages in the deployment step

### "Connection error" in the app
- Verify the URL doesn't have a trailing slash
- Test with `/api/health` endpoint first
- Check that Cloud Run service is "Running" (not "Error")

### Emails not sending
- Verify SMTP credentials in Cloud Build substitutions
- Check Gmail account security settings
- Review Cloud Run logs for SMTP errors

### Database/Games not persisting
- Cloud Run instances restart frequently
- Consider using **Firebase Firestore** or **Cloud Datastore** for persistent storage
- Currently games are stored in ephemeral `/app/data/db.json`

## Next Steps: Persistent Database (Optional)

For a production setup, you should switch from file-based DB to:
- **Firebase Firestore** (no server cost, free tier)
- **Cloud SQL** (PostgreSQL/MySQL)
- **MongoDB Atlas** (free tier)

Update `server.ts` to use these instead of `db.json`.

## Cost Estimation

Using Google Cloud Run free tier:
- **Free per month**: 2 million requests, 360,000 GB-seconds
- **Estimated usage**: Minimal cost for small user base
- **Upgrade needed**: Only if you exceed free tier limits

## Questions or Issues?

Check these resources:
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud Build Documentation](https://cloud.google.com/build/docs)
- Your Cloud Run logs in the Console
