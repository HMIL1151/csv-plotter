# Offline Plotly (optional)

`index.html` loads `plotly-2.35.2.min.js` from this folder if it exists, and
falls back to the Plotly CDN otherwise. To use the app with no internet
connection, download the file once:

```bash
curl -o web/vendor/plotly-2.35.2.min.js https://cdn.plot.ly/plotly-2.35.2.min.js
```

The file is about 4.5 MB, so it is git-ignored rather than committed.
