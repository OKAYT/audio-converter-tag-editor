# Audio Converter and Tag Editor

Convert songs or recordings, identify the title/artist/writer, and edit the tags before downloading.

## Files

Keep these together in the same folder:

- `index.html` — the page
- `style.css` — the UI styling
- `script.js` — recognition, tags and audio conversion
- `START AudioTag.bat` — one-click local server for Windows
- `.vscode/tasks.json` — VS Code "run server" task

## Quick start (Windows)

### Option 1 — one click

Double-click `START AudioTag.bat`, then open <http://localhost:8000>.

### Option 2 — VS Code

1. Open this folder in VS Code: **File → Open Folder…**
2. Press **Ctrl + Shift + B** and choose **Start AudioTag server**.
3. Open <http://localhost:8000> in your browser.

Or use the terminal:

```powershell
python -m http.server 8000
```

If `python` is not recognized:

```powershell
py -m http.server 8000
```

### Option 3 — no server

Double-click `index.html`. Upload, identify, edit and convert work, but the microphone may be blocked by the browser. Use localhost for the microphone.

## How to use

1. **Upload song** tab — drop an MP3/WAV/OGG/M4A file.
2. Or **Microphone** tab — click the mic button, allow access, play the song near the mic for ~12 seconds.
3. Title, artist, album, year and writer fill in automatically when a match is found.
4. The match card also shows **YouTube** and **Spotify** buttons that search for that artist and title in a new tab. They follow any edits you make to the title or artist.
5. Edit anything manually if needed.
6. Choose the output format and click **Download with tags**.

## Notes

- Song recognition needs an internet connection.
- It works without an API token for light use. If the free limit is reached, get a token at <https://dashboard.audd.io/> and paste it into the **AudD API token** field.
- Microphone access requires `http://localhost` or `https://`.
- To stop the server, press **Ctrl + C** in the terminal.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `python` is not recognized | Use `py -m http.server 8000`, or install Python and tick "Add python.exe to PATH". |
| Port 8000 already in use | Use `python -m http.server 8001` and open `http://localhost:8001`. |
| Microphone does not start | Open the app through `http://localhost:8000`, allow mic permission, and check the input device. |
| "No match" | Use a clearer/louder 12-second clip, or upload the audio file instead. |
| MP3 conversion fails | Check your internet connection — the MP3 encoder is loaded from a CDN. |
