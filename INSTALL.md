# Install V380 SD sync on Windows

This installs the program that copies V380 SD card recordings to MP4 files on this PC. The camera and the PC must be on the same network.

The setup file is not signed by Microsoft. The browser and Windows warn about that. Choose the keep and run options below. The file is the latest installer from this project:

<!-- Keep this URL. It always downloads the newest installer. Do not replace it with a version number. -->

[Download V380SdSync-Setup.exe](https://github.com/torrefrancae/v380-sd-card-pc-sync/releases/latest/download/V380SdSync-Setup.exe)

## If the browser blocks the download

Edge and Chrome often stop an installer that is not a commonly downloaded, signed Windows app.

In **Edge**:

1. Open the download bar.
2. Click the three dots next to `V380SdSync-Setup.exe`.
3. Choose **Keep**.
4. If a second prompt appears, choose **Keep anyway**.

In **Chrome**:

1. Open the download list.
2. Choose **Keep** next to the blocked file.
3. If Chrome asks again, choose **Keep anyway**.

## If Windows blocks the file when you open it

Windows SmartScreen can show **Windows protected your PC**.

1. Click **More info**.
2. Click **Run anyway**.

## Set the camera username and password

Do this in the V380 app on Android or iOS before you use this program. The camera needs its own username and password. That login is not the V380 account email or account password.

1. Open the camera in the V380 app.
2. Tap the three dots at the top right of the camera.
3. Tap **Settings**.
4. Tap **Password**.
5. Tap **Change device password**.
6. Set a username and a password. Enter the password twice so you do not forget the new one.
7. Remember that username and password. You type the same ones into this program.

## Setup

1. Run `V380SdSync-Setup.exe`. It does not ask for an administrator password.
2. Setup stays open while the program starts. The first start can take a minute. The browser opens [http://127.0.0.1:8787](http://127.0.0.1:8787) only after that page answers. You do not type that address.
3. Click **Find on network** and select the camera. **Scan V380** is only for a PC that already has the V380 app installed and signed in.
4. Enter the **username** and **password** you set in the phone app. Use that same login here.
5. Click **Save camera**, or click **Start download**. Starting a download saves the camera on this PC.
6. The page becomes a file list. The newest day is open. Older days stay closed until you open them.
7. An older local copy is deleted only when a new video is saved, one in and one out. Open **Settings** to keep a different number of minutes, hours, days, weeks, or months, then click **Apply keep**. The default is 30 days. Clear the number to keep every saved video. The camera SD card is not changed.

The next time, choose the camera under **Saved cameras**. Closing the page leaves the download running. **Pause** holds it, and **Play** continues from the clips already saved.

A desktop and Start menu shortcut named **V380 SD Sync** opens the page again.
