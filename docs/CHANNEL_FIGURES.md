# Show individual fluorescence channels beside a merge

A merge shows where signals coincide. Separate grayscale panels let readers inspect a faint structure in one channel even when a brighter channel dominates the merge. Loci can export both views on the same image grid. Royle’s Figure 3 illustrates when this is particularly helpful for readers with color vision deficiencies. [Royle, *Journal of Cell Science* (2026)](https://doi.org/10.1242/jcs.265371) · [Author’s figure tools](https://doi.org/10.5281/zenodo.18172496)

1. Open **View → Image & channels**. Show the two or more scalar channels you want to compare. Choose the plane, projection or analysis region, and adjust each channel’s display window.
2. Expand **Export rendered image**. Under **Layout**, select **Grayscale channels + merge (row)** or **Grayscale channels + merge (column)**. Check the channel labels against the acquisition or study declarations.
3. Choose the extent and output format. PNG provides an 8-bit overview or bounded region. TIFF provides 16-bit display values on the selected plane or region. **Invert grayscale panels** puts dark signal on white and keeps the colors and polarity of the merge.
4. Add a scale bar for calibrated images, set the publication DPI and export. The scale bar applies to each equally sampled panel. DPI controls print size. The image geometry determines physical distances.

Each header gives the channel name and display window. The file embeds the source fingerprint, selection, channel indices and numerical display settings. Gamma and opacity apply to both representations. RGB photographs and palette-indexed images lack separate scalar acquisition channels for this workflow. Use **Export scientific data** for original intensities, labels and object measurements. [Scientific data export](SCIENTIFIC_DATA_EXPORT.md)
