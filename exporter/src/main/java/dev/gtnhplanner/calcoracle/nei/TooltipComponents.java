package dev.gtnhplanner.calcoracle.nei;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Chromatic Tooltips draws some tooltip lines itself: it swaps each for a placeholder ("§z<id>§Z", or
 * "§Z<id>§z" when permanent) naming a component in its registry, and looks it up only while drawing.
 * GTNHLib's animated tooltips (GregTech's voltage tiers, StructureLib's channel hints) all become such
 * components, so ItemStack.getTooltip hands back placeholders, which the site's font would draw as
 * a wavy number. This puts their text back, and samples the text that changes over time.
 */
public final class TooltipComponents {

    private static final Pattern PLACEHOLDER = Pattern.compile("§z\\d+§Z|§Z\\d+§z");
    /** Sampling of changing text: every 50 ms for 4.2 s, a whole cycle of each tier's colours. */
    static final int STEP_MS = 50;
    private static final int SAMPLES = 84;

    private static boolean lookedUp;
    private static Method getComponent;

    private TooltipComponents() {}

    public static boolean isPlaceholder(String line) {
        return line != null && PLACEHOLDER.matcher(line).matches();
    }

    /** A tooltip's lines with every placeholder replaced by its text as it reads now (none if unknown). */
    public static List<String> expand(List<String> lines) {
        List<String> out = new ArrayList<String>();
        for (String line : lines) {
            Object source = source(line);
            if (source instanceof Supplier) {
                Collections.addAll(out, text((Supplier<?>) source).split("\n", -1));
            } else if (source instanceof List) {
                for (Object l : (List<?>) source) out.add(String.valueOf(l));
            } else if (!isPlaceholder(line)) {
                out.add(line);
            }
        }
        return out;
    }

    /**
     * Like {@link #expand}, and notes each changing line in {@code changing} (with its place in the
     * returned lines) for {@link #sample} to record.
     */
    static List<String> expand(List<String> lines, Map<String, Object> item, List<Changing> changing) {
        List<String> out = new ArrayList<String>();
        for (String line : lines) {
            Object source = source(line);
            if (source instanceof Supplier) {
                String[] parts = text((Supplier<?>) source).split("\n", -1);
                changing.add(new Changing(item, out.size(), parts.length, (Supplier<?>) source));
                Collections.addAll(out, parts);
            } else if (source instanceof List) {
                for (Object l : (List<?>) source) out.add(String.valueOf(l));
            } else if (!isPlaceholder(line)) {
                out.add(line);
            }
        }
        return out;
    }

    /** Text of a line that comes from a supplier (GTNHLib's animated tooltips). */
    static final class Changing {
        final Map<String, Object> item;
        final int line, count;
        final Supplier<?> source;
        final List<String> samples = new ArrayList<String>();

        Changing(Map<String, Object> item, int line, int count, Supplier<?> source) {
            this.item = item;
            this.line = line;
            this.count = count;
            this.source = source;
        }
    }

    /**
     * Reads every changing line {@link #SAMPLES} times, {@link #STEP_MS} apart, and gives each item whose
     * text really changes a "tooltipAnim" list: per changing line, its index in "tooltip", how many
     * lines it spans, the step in ms and the frames as [text, number of steps] pairs.
     */
    static void sample(List<Changing> changing) throws InterruptedException {
        if (changing.isEmpty()) return;
        long start = System.currentTimeMillis();
        for (int s = 0; s < SAMPLES; s++) {
            long due = start + (long) s * STEP_MS - System.currentTimeMillis();
            if (due > 0) Thread.sleep(due);
            Map<Object, String> round = new IdentityHashMap<Object, String>();
            for (Changing c : changing) {
                String v = round.get(c.source);
                if (v == null) {
                    v = text(c.source);
                    round.put(c.source, v);
                }
                c.samples.add(v);
            }
        }
        for (Changing c : changing) {
            boolean moves = false, fits = true;
            for (String v : c.samples) {
                moves |= !v.equals(c.samples.get(0));
                fits &= v.split("\n", -1).length == c.count;
            }
            if (!moves || !fits) continue;
            List<Object> frames = new ArrayList<Object>();
            String last = null;
            int run = 0;
            for (String v : c.samples) {
                if (v.equals(last)) {
                    run++;
                    continue;
                }
                if (last != null) frames.add(pair(last, run));
                last = v;
                run = 1;
            }
            frames.add(pair(last, run));
            Map<String, Object> anim = new LinkedHashMap<String, Object>();
            anim.put("line", Integer.valueOf(c.line));
            anim.put("lines", Integer.valueOf(c.count));
            anim.put("step", Integer.valueOf(STEP_MS));
            anim.put("frames", frames);
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) c.item.get("tooltipAnim");
            if (list == null) {
                list = new ArrayList<Object>();
                c.item.put("tooltipAnim", list);
            }
            list.add(anim);
        }
    }

    private static List<Object> pair(String text, int steps) {
        List<Object> p = new ArrayList<Object>();
        p.add(text);
        p.add(Integer.valueOf(steps));
        return p;
    }

    private static String text(Supplier<?> source) {
        try {
            Object v = source.get();
            return v == null ? "" : String.valueOf(v);
        } catch (Throwable t) {
            return "";
        }
    }

    /** What a placeholder stands for: a Supplier of changing text, a List of fixed lines, or null. */
    private static Object source(String line) {
        if (!isPlaceholder(line)) return null;
        if (!lookedUp) {
            lookedUp = true;
            try {
                getComponent = Class.forName("com.slprime.chromatictooltips.TooltipHandler")
                    .getMethod("getTooltipComponent", String.class);
            } catch (Throwable ignored) {
                getComponent = null;
            }
        }
        if (getComponent == null) return null;
        Object component;
        try {
            component = getComponent.invoke(null, line);
        } catch (Throwable t) {
            return null;
        }
        if (component == null) return null;
        Object handler = NeiHandlerExporter.call(component, "getHandler");
        if (handler instanceof Supplier) return handler;
        Object lines = NeiHandlerExporter.call(component, "getLines");
        return lines instanceof List ? lines : null;
    }
}
