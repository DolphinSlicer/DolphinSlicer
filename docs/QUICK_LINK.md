# "Slice now" links

Put a link on a model page, and DolphinSlicer opens with that model on the plate, ready to
slice. The model is not uploaded anywhere: the visitor's browser downloads it straight from your
site.

## The link

```
https://dolphinslicer.app/?model=<address of the model file>
```

The model address must be URL-encoded (in JavaScript, `encodeURIComponent(url)`). STL, 3MF, OBJ
and AMF files work.

```html
<a href="https://dolphinslicer.app/?model=https%3A%2F%2Fexample.com%2Ffiles%2Fbenchy.stl">
  <img src="https://dolphinslicer.app/slice-now.svg" alt="Slice now in DolphinSlicer" width="128" height="36">
</a>
```

The button image is optional; any link or button works.

**More than one file:** repeat `model=`; each file is imported, as when several files are dropped
on the app.

```
https://dolphinslicer.app/?model=…part1.stl&model=…part2.stl
```

**Download links without a file name** (`/download?id=123`): the app takes the name from the
`Content-Disposition` header if your server sends it (and exposes it, see below), otherwise it
recognizes the file type from its content. To set the name yourself, add `name=` after each
`model=`:

```
https://dolphinslicer.app/?model=https%3A%2F%2Fexample.com%2Fdownload%3Fid%3D123&name=Benchy.3mf
```

## Your server must allow it (CORS)

Browsers let one site download a file from another only when that site says so with an
`Access-Control-Allow-Origin` header. Without it, DolphinSlicer shows "… doesn't let other sites
download this file" and the visitor has to download and drop the file by hand. DolphinSlicer
does not route downloads through a server of its own.

Send these headers with the model files:

```
Access-Control-Allow-Origin: https://dolphinslicer.app
Access-Control-Expose-Headers: Content-Disposition
```

(`*` instead of the address allows every site. The second line is needed only if the app should
read the file name from `Content-Disposition`.) The download must work without cookies or a
login: the browser sends none.

- **nginx:** in the `location` that serves the files:
  `add_header Access-Control-Allow-Origin https://dolphinslicer.app always;`
- **Apache:** `Header set Access-Control-Allow-Origin "https://dolphinslicer.app"`
- **Amazon S3, Cloudflare R2, Google Cloud Storage:** add a CORS rule allowing `GET` from
  `https://dolphinslicer.app`.
- **GitHub:** `raw.githubusercontent.com` links already allow it.

## Self-hosted copies

The same works with any copy of DolphinSlicer, e.g. one served from a printer
(`docs/SELF_HOST_PI.md`): `http://printer.local/dolphin/?model=…`.
