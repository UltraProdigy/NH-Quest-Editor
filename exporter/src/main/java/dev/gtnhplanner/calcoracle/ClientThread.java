package dev.gtnhplanner.calcoracle;

import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Runs work on the client thread for the export, which itself runs on its own thread. Anything
 * that touches OpenGL (binding a texture, creating a font renderer) or the GUI state the render
 * loop reads must run there; calling GL from another thread has no context and crashes the JVM.
 * ClientAutorunHandler runs the queue at the end of every client tick.
 */
public final class ClientThread {

    private static final ConcurrentLinkedQueue<FutureTask<?>> QUEUE = new ConcurrentLinkedQueue<FutureTask<?>>();
    private static volatile Thread clientThread;

    private ClientThread() {}

    /** Called from the client tick: runs everything queued so far. */
    static void runPending() {
        clientThread = Thread.currentThread();
        FutureTask<?> task;
        while ((task = QUEUE.poll()) != null) {
            task.run();
        }
    }

    /** Runs `work` on the client thread and waits for its result. */
    public static <T> T call(Callable<T> work, long timeoutMinutes) throws Exception {
        if (Thread.currentThread() == clientThread) {
            return work.call();
        }
        FutureTask<T> task = new FutureTask<T>(work);
        QUEUE.add(task);
        return task.get(timeoutMinutes, TimeUnit.MINUTES);
    }
}
