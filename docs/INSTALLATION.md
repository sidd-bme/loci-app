# Install Loci on macOS

The current development beta is for **Apple Silicon Macs**.

1. Download **`Loci-0.2.0-beta.2-darwin-arm64.zip`** from the [release page](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.2).
2. Download `SHA256SUMS.txt` to the same folder. To check the archive in Terminal, run:

   ```sh
   shasum -a 256 Loci-0.2.0-beta.2-darwin-arm64.zip
   ```

   Compare the result with the matching entry in `SHA256SUMS.txt`.
3. Unzip the archive and move `Loci.app` to **Applications**.
4. Open Loci. This development beta is **unnotarized** and uses an ad-hoc integrity signature, so macOS may block its first launch. Follow [Apple’s instructions](https://support.apple.com/en-au/102445): open **System Settings → Privacy & Security**, choose **Open Anyway** for Loci, and confirm **Open**. Managed Macs may require help from your IT administrator.

The first launch can take longer while macOS checks the application. Keep the
app open while it starts. No model checkpoints are bundled or downloaded
silently; the [Cellpose guide](CELLPOSE_COMPATIBILITY.md) covers supplying a model.

## Your first study

[Open your first image](workflows/FIRST_STUDY.md), adjust its display and try a
recipe. Review the result before exporting measurements, and use **Save study…**
to return to your work later.

The [user manual](USING_LOCI.md) is also available inside Loci. For terminal
workflows, see the [CLI guide](CLI.md).

## Release details

The release includes checksums, dependency licences, software inventories and
an evidence record. See [release status](RELEASE_STATUS.md) for the exact build
and checks. Earlier releases remain available on GitHub.

Windows, Linux and Intel Mac installers are not included in this beta.
