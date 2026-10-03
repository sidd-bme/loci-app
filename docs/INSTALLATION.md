# Install Loci on macOS

The downloadable beta is for **Apple Silicon Macs**. Windows and Intel Mac installers are not offered in this release.

1. Download **`Loci-0.1.0-beta.1-darwin-arm64-repack1.zip`** (recommended) from the [GitHub Releases](https://github.com/sidd-bme/loci-app/releases/tag/v0.1.0-beta.1) page.
2. *(Recommended)* Verify the SHA-256 checksum in Terminal:
   ```bash
   shasum -a 256 Loci-0.1.0-beta.1-darwin-arm64-repack1.zip
   # Expected: cc0fbf5503cdda76bb1cacd4f050f35fd7af773f8bc430f89b00743029bd0cd0
   ```
3. Unzip the archive and move `Loci.app` to your `/Applications` folder.
4. **First-launch Gatekeeper approval:** Because this initial beta release uses an ad-hoc local integrity signature and is **not notarized** by Apple, macOS Gatekeeper blocks direct double-click launching on downloaded files. Follow [Apple’s instructions for opening an app from an unidentified developer](https://support.apple.com/en-au/102445):
   - **On macOS 15 (Sequoia) and modern macOS versions:**
     1. Double-click `Loci.app` in `/Applications` once. macOS will display a prompt stating that the app cannot be opened because it is not from an identified developer. Click **Done** or **OK**.
     2. Open **System Settings → Privacy & Security**.
     3. Scroll down to the **Security** section. You will see: *"Loci.app was blocked from use because it is not from an identified developer."*
     4. Click **Open Anyway**, enter your Mac password or Touch ID when prompted, and click **Open**.
   - **On earlier macOS versions (macOS 14 Sonoma and earlier):**
     Right-click (or Control-click) `Loci.app` in `/Applications` and select **Open**. In the dialog that appears, click **Open**. *(Note: macOS Sequoia restricts this shortcut by default in favor of System Settings approval).*
   *Note for managed Macs: On institutional or enterprise-managed Macs with centrally enforced MDM configuration profiles, running unnotarized applications may require your organization's IT administrator to grant an exception.*
5. **Initial startup timing:** On first launch on Apple Silicon Macs, an initial startup delay of approximately **75–85 seconds** has been observed (tested on Apple Silicon M1 with 8 GB RAM) while macOS verifies application components and the analysis environment initializes. Subsequent launches open faster once cached by the system.

## Your first study

Open an image, adjust its display, then define a region for analysis. Review the result before exporting measurements, and use **Save study…** to return to your work later.

Continue with the [user guide](USING_LOCI.md) or [documentation index](README.md).

## Release details

The release page also retains the original archive and provides checksums, dependency licences and release evidence. `repack1` removes archive-level metadata; it does not change the application. Development source and screenshots can evolve between beta downloads. See the [release record](RELEASE_STATUS.md) for artifact identities and qualification details.
