/* Bounded ImageJ 1.x arithmetic/topology comparator using an operator-supplied JAR.
 * FloodFiller.fill is four-connected; ParticleAnalyzer's hole-filling scratch route
 * is deliberately avoided. This is not a Fiji GUI or scalability comparison.
 */
import ij.IJ;
import ij.ImagePlus;
import ij.io.FileInfo;
import ij.io.TiffDecoder;
import ij.measure.Calibration;
import ij.measure.Measurements;
import ij.process.ByteProcessor;
import ij.process.FloodFiller;
import ij.process.ImageProcessor;
import ij.process.ImageStatistics;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;

class PublicationImageJBaseline {
    static final long MAX_FILE_BYTES = 16L * 1024 * 1024;
    static final long MAX_PIXELS = 1_000_000;
    static final long MAX_PIXEL_COMPONENT_WORK = 64_000_000;
    static final int METRICS = Measurements.AREA | Measurements.MEAN
            | Measurements.CENTROID | Measurements.MIN_MAX;

    static Path absentOutput(String value) throws Exception {
        Path path = Path.of(value).toAbsolutePath().normalize();
        Path parent = path.getParent().toRealPath();
        path = parent.resolve(path.getFileName());
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS))
            throw new IllegalArgumentException("Output must be absent: " + path);
        return path;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 6 && args.length != 7)
            throw new IllegalArgumentException("source.tif absent-results.csv spacingX spacingY exclusiveThreshold minimumArea [absent-labels.csv]");
        Path input = Path.of(args[0]).toRealPath();
        Path output = absentOutput(args[1]);
        Path labelsOutput = args.length == 7 ? absentOutput(args[6]) : null;
        if (output.equals(labelsOutput)) throw new IllegalArgumentException("Outputs must be distinct");
        double sx = Double.parseDouble(args[2]), sy = Double.parseDouble(args[3]);
        double threshold = Double.parseDouble(args[4]), minArea = Double.parseDouble(args[5]);
        double pixelArea = sy * sx;
        if (!(Double.isFinite(sx) && sx > 0 && Double.isFinite(sy) && sy > 0
                && Double.isFinite(pixelArea) && pixelArea > 0
                && Double.isFinite(threshold) && threshold >= 0 && threshold <= 65535
                && Double.isFinite(minArea) && minArea >= 0))
            throw new IllegalArgumentException("Explicit finite positive calibration and bounded settings required");
        // Admission precedes image pixel allocation. This deliberately supports
        // small TIFF fixtures, not general formats, stacks or unbounded decoding.
        if (!Files.isRegularFile(input) || Files.size(input) > MAX_FILE_BYTES)
            throw new IllegalArgumentException("TIFF must be a regular file of at most 16 MiB");
        FileInfo[] info = new TiffDecoder(input.getParent().toString() + "/", input.getFileName().toString()).getTiffInfo();
        if (info == null || info.length != 1 || info[0].nImages != 1
                || (info[0].fileType != FileInfo.GRAY8 && info[0].fileType != FileInfo.GRAY16_UNSIGNED)
                || info[0].width <= 0 || info[0].height <= 0
                || (long)info[0].width * info[0].height > MAX_PIXELS)
            throw new IllegalArgumentException("One scalar uint8/uint16 TIFF plane of at most 1000000 pixels required");
        if (!Double.isFinite((double)info[0].width * info[0].height * sy * sx))
            throw new IllegalArgumentException("Calibrated plane area must be finite");
        ImagePlus image = IJ.openImage(input.toString());
        if (image == null) throw new IllegalArgumentException("ImageJ could not decode TIFF");
        try {
            if (image.getStackSize() != 1 || image.getNChannels() != 1
                    || (image.getBitDepth() != 8 && image.getBitDepth() != 16)
                    || image.getWidth() != info[0].width || image.getHeight() != info[0].height)
                throw new IllegalArgumentException("Decoded plane differs from admitted TIFF");
            Calibration calibration = new Calibration();
            calibration.pixelWidth = sx;
            calibration.pixelHeight = sy;
            calibration.setUnit("um");
            image.setCalibration(calibration);
            ImageProcessor raw = image.getProcessor();
            Object initial = raw.getPixels() instanceof byte[]
                    ? ((byte[])raw.getPixels()).clone() : ((short[])raw.getPixels()).clone();
            int w = raw.getWidth(), h = raw.getHeight(), n = w * h;
            int[] labels = new int[n];
            ByteProcessor remaining = new ByteProcessor(w, h);
            for (int i = 0; i < n; i++) if (raw.get(i) > threshold) remaining.set(i, 255);
            remaining.setValue(128);
            FloodFiller fill = new FloodFiller(remaining);
            ByteProcessor mask = new ByteProcessor(w, h);
            byte[] maskPixels = (byte[])mask.getPixels();
            StringBuilder csv = new StringBuilder("label,area_um2,mean,min,max,raw_sum,imagej_x_um,imagej_y_um,loci_origin_x_um,loci_origin_y_um\n");
            int components = 0, survivors = 0;
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
                if (remaining.get(x, y) != 255) continue;
                if ((long)++components * n > MAX_PIXEL_COMPONENT_WORK)
                    throw new IllegalArgumentException("Comparator pixel-component work exceeds 64000000");
                if (!fill.fill(x, y)) throw new IllegalStateException("ImageJ component fill failed");
                Arrays.fill(maskPixels, (byte)0);
                int count = 0;
                for (int i = 0; i < n; i++) if (remaining.get(i) == 128) {
                    mask.set(i, 255);
                    count++;
                    remaining.set(i, 0);
                }
                if (count == 0) throw new IllegalStateException("Empty filled component");
                // Match the declared physical filtering order, then compact IDs.
                if (count * sy * sx < minArea) continue;
                raw.setRoi(0, 0, w, h);
                raw.setMask(mask);
                raw.resetThreshold();
                ImageStatistics stats = ImageStatistics.getStatistics(raw, METRICS, calibration);
                if (stats.pixelCount != count) throw new IllegalStateException("ImageJ mask count mismatch");
                int label = ++survivors;
                double[] values = {label, stats.area, stats.mean, stats.min, stats.max,
                        stats.mean * stats.pixelCount, stats.xCentroid, stats.yCentroid,
                        stats.xCentroid - sx / 2, stats.yCentroid - sy / 2};
                // ImageJ coordinates reference outer pixel edges. The last two
                // columns place the centre of sample [0,0] at world [0,0].
                for (int column = 0; column < values.length; column++) {
                    if (!Double.isFinite(values[column])) throw new IllegalStateException("Non-finite measurement");
                    if (column > 0) csv.append(',');
                    csv.append(Double.toString(values[column]));
                }
                csv.append('\n');
                for (int i = 0; i < n; i++) if (mask.get(i) != 0) labels[i] = label;
            }
            boolean preserved = initial instanceof byte[]
                    ? Arrays.equals((byte[])initial, (byte[])raw.getPixels())
                    : Arrays.equals((short[])initial, (short[])raw.getPixels());
            if (!preserved) throw new IllegalStateException("Original raw samples changed");
            // No output is published before all numerical/admission checks pass.
            Files.writeString(output, csv, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            if (labelsOutput != null) {
                StringBuilder matrix = new StringBuilder();
                for (int i = 0; i < n; i++) {
                    if (i % w != 0) matrix.append(',');
                    matrix.append(labels[i]);
                    if (i % w == w - 1) matrix.append('\n');
                }
                Files.writeString(labelsOutput, matrix, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            }
            System.out.println("ImageJ=" + IJ.getVersion());
            System.out.println("Java=" + System.getProperty("java.version"));
            System.out.println("Objects=" + survivors);
            System.out.println("Components=" + components);
            System.out.println("RawSamplesPreserved=true");
        } finally {
            image.close();
        }
    }
}
