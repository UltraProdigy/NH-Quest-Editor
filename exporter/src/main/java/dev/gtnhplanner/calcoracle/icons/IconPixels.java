package dev.gtnhplanner.calcoracle.icons;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;

/** Pixel helpers shared by the icon passes: GL readback to ARGB, and lossless shrinking. */
public final class IconPixels {

    private IconPixels() {}

    /**
     * The pixels of a glReadPixels(GL_RGBA, GL_UNSIGNED_BYTE) buffer as ARGB ints, top row first (GL's
     * rows are bottom-up). Copies whole rows at a time rather than reading byte by byte.
     */
    public static int[] argbFromRgba(ByteBuffer rgba, int width, int height) {
        IntBuffer ints = rgba.duplicate().order(ByteOrder.BIG_ENDIAN).asIntBuffer();
        int[] out = new int[width * height];
        for (int y = 0; y < height; y++) {
            ints.position((height - 1 - y) * width);
            ints.get(out, y * width, width);
        }
        for (int i = 0; i < out.length; i++) {
            int v = out[i]; // RRGGBBAA
            out[i] = (v >>> 8) | (v << 24);
        }
        return out;
    }

    public static boolean anyVisible(int[] argb) {
        for (int v : argb) {
            if ((v >>> 24) != 0) return true;
        }
        return false;
    }

    /**
     * The smallest side, down to {@code minSide}, that a square {@code size} px image can be stored at
     * without losing anything: it is halved only while every block of pixels it merges has one colour
     * (fully transparent pixels count as equal), so nearest-neighbour enlarging gives back the original
     * exactly. Flat 16 px items on the 32-unit canvas come out at 32 px.
     */
    public static int losslessSide(int[] argb, int size, int minSide) {
        int step = 1;
        while (size / (step * 2) >= minSide && size % (step * 2) == 0 && uniformBlocks(argb, size, step * 2)) {
            step *= 2;
        }
        return size / step;
    }

    /** Every {@code size / side}-th pixel of each row and column: the image at {@code side} px. */
    public static int[] shrink(int[] argb, int size, int side) {
        if (side == size) return argb;
        int step = size / side;
        int[] out = new int[side * side];
        for (int y = 0; y < side; y++) {
            int row = y * step * size;
            for (int x = 0; x < side; x++) out[y * side + x] = argb[row + x * step];
        }
        return out;
    }

    static boolean uniformBlocks(int[] px, int size, int step) {
        for (int by = 0; by < size; by += step) {
            for (int bx = 0; bx < size; bx += step) {
                int first = px[by * size + bx];
                if ((first >>> 24) == 0) first = 0;
                for (int y = by; y < by + step; y++) {
                    int row = y * size;
                    for (int x = bx; x < bx + step; x++) {
                        int v = px[row + x];
                        if ((v >>> 24) == 0) v = 0;
                        if (v != first) return false;
                    }
                }
            }
        }
        return true;
    }
}
