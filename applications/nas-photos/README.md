# NAS Photos

Publishes one random eligible photo from a local NAS to a saved paperlesspaper Paper using the official Content Push API.

## Architecture

- The Mac reads the existing local photo index and the mounted NAS share.
- The Mac makes an outbound HTTPS request to the Cloudflare Worker.
- The Worker stores the PaperlessPaper connection credentials in Cloudflare KV and forwards the image to the Content Push API.
- The frame displays the latest image for this Paper. Other Papers in Diashow remain independent.
- The NAS and Mac accept no incoming internet connections.

## Files

- `config.json`: Open Integration manifest.
- `settings.html`: Requests a one-time connection grant from the host.
- `render.html`: Displays the pushed image supplied in `integrationContent`.
- `worker.js`: Cloudflare Worker backend.
- `uploader.py`: Mac-side random photo publisher.

## Security

The permanent PaperlessPaper content and callback tokens are stored only in the Worker KV namespace. The Mac authenticates to the Worker with a separate upload secret. Never commit that secret or the PaperlessPaper tokens.

The callback validates the callback bearer token and connection/paper identifiers. Callback events are deduplicated by event ID.

## Limits

Content Push accepts JPEG, PNG and WebP images up to 20 MiB and 40 megapixels. Each submission replaces the previous content for this Paper. A push does not wake a sleeping frame.
