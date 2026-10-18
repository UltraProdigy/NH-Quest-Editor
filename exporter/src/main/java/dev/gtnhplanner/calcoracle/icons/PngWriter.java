package dev.gtnhplanner.calcoracle.icons;

import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import javax.imageio.ImageIO;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * Encodes and writes PNGs on background threads, so the client thread can go on rendering while the
 * previous pictures are compressed. The queue is bounded: when it is full the client thread encodes
 * the next picture itself, which keeps memory in check if rendering outpaces the encoders.
 *
 * <p>{@code -Dgtnh.oracle.pngWriterThreads=N} sets the number of encoder threads (default: one less
 * than the processors, at most 4); 0 writes every picture on the calling thread. Call
 * {@link #awaitAll()} before anything reads the files, and before the game exits.
 */
public final class PngWriter {

    private static final int THREADS = Integer.getInteger(
        "gtnh.oracle.pngWriterThreads",
        Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 1))
    );
    private static final AtomicInteger PENDING = new AtomicInteger();
    private static final AtomicInteger FAILURES = new AtomicInteger();
    private static final AtomicInteger WRITTEN = new AtomicInteger();
    private static final AtomicLong ENCODE_NANOS = new AtomicLong();
    private static final Object LOCK = new Object();
    private static ThreadPoolExecutor pool;

    private PngWriter() {}

    /**
     * Writes {@code argb} ({@code width} x {@code height}, top row first) as a PNG to {@code file}, and
     * copies it to each of {@code copies} that is not null. The array must not be changed afterwards.
     */
    public static void write(final int[] argb, final int width, final int height, final File file, final File... copies) {
        Runnable task = new Runnable() {
            @Override
            public void run() {
                long start = System.nanoTime();
                try {
                    BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
                    image.setRGB(0, 0, width, height, argb, 0, width);
                    File parent = file.getParentFile();
                    if (parent != null && !parent.isDirectory()) parent.mkdirs();
                    ImageIO.write(image, "png", file);
                    for (File copy : copies) {
                        if (copy == null) continue;
                        File copyParent = copy.getParentFile();
                        if (copyParent != null && !copyParent.isDirectory()) copyParent.mkdirs();
                        Files.copy(file.toPath(), copy.toPath(), StandardCopyOption.REPLACE_EXISTING);
                    }
                    WRITTEN.incrementAndGet();
                } catch (Throwable t) {
                    if (FAILURES.incrementAndGet() <= 20) {
                        GtnhCalcOracleMod.LOG.warn("Could not write " + file + ": " + t);
                    }
                } finally {
                    ENCODE_NANOS.addAndGet(System.nanoTime() - start);
                    if (PENDING.decrementAndGet() == 0) {
                        synchronized (LOCK) {
                            LOCK.notifyAll();
                        }
                    }
                }
            }
        };
        PENDING.incrementAndGet();
        ThreadPoolExecutor executor = pool();
        if (executor == null) {
            task.run();
        } else {
            executor.execute(task);
        }
    }

    /** Waits until every picture handed to {@link #write} is on disk. */
    public static void awaitAll() {
        long start = System.nanoTime();
        synchronized (LOCK) {
            while (PENDING.get() > 0) {
                try {
                    LOCK.wait(100L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
        long waited = (System.nanoTime() - start) / 1000000L;
        GtnhCalcOracleMod.LOG.info(
            "GTNH PNG writer: " + WRITTEN.get() + " written, " + FAILURES.get() + " failed, "
                + ENCODE_NANOS.get() / 1000000000L + " s encoding on " + Math.max(THREADS, 1)
                + " thread(s), waited " + waited + " ms for the last ones."
        );
    }

    private static synchronized ThreadPoolExecutor pool() {
        if (THREADS <= 0) return null;
        if (pool == null) {
            pool = new ThreadPoolExecutor(
                THREADS,
                THREADS,
                30L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(512),
                new ThreadFactory() {
                    private final AtomicInteger n = new AtomicInteger();

                    @Override
                    public Thread newThread(Runnable r) {
                        Thread thread = new Thread(r, "gtnh-oracle-png-" + n.incrementAndGet());
                        thread.setDaemon(true);
                        thread.setPriority(Thread.NORM_PRIORITY - 1);
                        return thread;
                    }
                },
                new ThreadPoolExecutor.CallerRunsPolicy()
            );
        }
        return pool;
    }
}
