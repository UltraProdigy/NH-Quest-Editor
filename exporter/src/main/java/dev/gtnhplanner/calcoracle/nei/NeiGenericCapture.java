package dev.gtnhplanner.calcoracle.nei;

import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.call;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.callStatic;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.field;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.iterable;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.staticField;

import java.awt.image.BufferedImage;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.imageio.ImageIO;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.client.renderer.OpenGlHelper;
import net.minecraft.client.renderer.RenderHelper;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.FluidStack;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * Captures what NEI shows for recipe handlers the site has no port of, the same way for every
 * handler: NEI loads the handler's recipes, and for each recipe the exporter records the stacks NEI
 * positions (ingredients, result, other stacks, with their permutations), the text the handler draws
 * (through a recording font renderer), and pictures of everything else it draws: drawBackground in
 * one layer, drawForeground's textures in another. Pictures are rendered off-screen at GUI scale 1
 * and stored once per distinct image, so a handler whose background never changes costs one file.
 *
 * Recipes come from TemplateRecipeHandler.getAllRecipeHandler (what NEI loads for a tab's "all
 * recipes"); handlers that load nothing that way are asked for each item of NEI's item list instead,
 * within a time budget, which also tells exactly which items each recipe is shown for.
 *
 * Fluid tanks (getFluidTanks() on a recipe, as Forestry, Tinkers' Construct and NEI Integration
 * have them) are recorded as stacks of their fluids, with the tooltip the tank gives.
 *
 * A foreground that moves with the handler's tick counter (progress bars drawn with
 * drawProgressBar) is recorded once per handler: the first recipe is drawn over a few hundred ticks,
 * the part of the picture that changes is cut out of every recipe's foreground, and pictures of that
 * part at each tick where it changes (within one period) are kept for the site to cycle through.
 *
 * Everything that draws runs on the client thread (ClientThread). Reflection only.
 */
public final class NeiGenericCapture {

    /** Space around the recipe area in the pictures, for handlers that draw outside it. */
    public static final int MARGIN = 16;
    private static final int MAX_RECIPES = 20000;
    /** Ticks the first recipe's foreground is drawn over to find an animation, and its key frames kept. */
    private static final int PROBE_TICKS = 480;
    private static final int MAX_KEYS = 64;

    private static final Set<String> SKIPPED = new HashSet<String>(Arrays.asList(
        "codechicken.nei.recipe.ProfilerRecipeHandler",
        "bq_standard.integration.nei.QuestRecipeHandler",
        "blockrenderer6343.integration.structurelib.StructureCompatNEIHandler",
        "blockrenderer6343.integration.gregtech.GTNEIMultiblockHandler",
        "hellfirepvp.beebetteratbees.client.gui.BBABGuiRecipeTreeHandler"));

    private final NeiHandlerExporter.Resources resources;
    private final File imageDir;
    public final List<String> warnings = new ArrayList<String>();

    /** Every stack the captured recipes show, once: the exporter's item maps. */
    public final List<Object> items = new ArrayList<Object>();
    private final Map<String, Integer> itemIds = new HashMap<String, Integer>();
    /** Picture files (in imageDir), once per distinct picture. */
    public final List<Object> images = new ArrayList<Object>();
    private final Map<String, Integer> imageIds = new HashMap<String, Integer>();
    /** Stands in for the font renderers while a handler draws (made once: it reads the glyph sizes). */
    private RecordingFontRenderer recorder;
    /** The handler being captured: its recipe width, and its foreground animation once probed. */
    private int handlerWidth = 166;
    private boolean animProbed;
    private Map<String, Object> anim;
    /** The part of the foreground that moves, in canvas pixels (rows bottom-up): x0, y0, x1, y1 inclusive. */
    private int[] animBox;

    public NeiGenericCapture(NeiHandlerExporter.Resources resources) {
        this.resources = resources;
        String dir = System.getProperty("gtnh.oracle.neiLayoutDir", "");
        this.imageDir = dir.length() == 0 ? null : new File(dir, "handlers");
        if (imageDir != null && !imageDir.isDirectory() && !imageDir.mkdirs()) {
            warn("cannot create " + imageDir);
        }
    }

    /** The handlers of NEI's recipe tabs this capture is for: [index in craftinghandlers, handler]. */
    public static List<Object[]> handlersToCapture() {
        List<Object[]> out = new ArrayList<Object[]>();
        Class<?> template = classOrNull("codechicken.nei.recipe.TemplateRecipeHandler");
        int index = 0;
        for (Object handler : iterable(staticField("codechicken.nei.recipe.GuiCraftingRecipe", "craftinghandlers"))) {
            String name = handler.getClass().getName();
            if (template != null && template.isInstance(handler) && !SKIPPED.contains(name) && !isPorted(handler)) {
                out.add(new Object[] { Integer.valueOf(index), handler });
            }
            index++;
        }
        return out;
    }

    /** Handlers the site draws itself: crafting, smelting and GregTech's. */
    private static boolean isPorted(Object handler) {
        String name = handler.getClass().getName();
        if ("codechicken.nei.recipe.ShapedRecipeHandler".equals(name)
            || "codechicken.nei.recipe.ShapelessRecipeHandler".equals(name)
            || "codechicken.nei.recipe.FurnaceRecipeHandler".equals(name)) {
            return true;
        }
        for (Class<?> c = handler.getClass(); c != null; c = c.getSuperclass()) {
            if ("gregtech.nei.GTNEIDefaultHandler".equals(c.getName())) return true;
        }
        return false;
    }

    /**
     * Captures one handler. Runs on the client thread. `itemList` is NEI's item list, used for
     * handlers that load nothing for "all recipes".
     */
    public Map<String, Object> capture(int index, Object handler, List<ItemStack> itemList, long budgetMillis) {
        long deadline = System.currentTimeMillis() + budgetMillis;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("index", Integer.valueOf(index));
        String className = handler.getClass().getName();

        Object info = callStatic("codechicken.nei.recipe.GuiRecipeTab", "getHandlerInfo", handler);
        int width = number(call(info, "getWidth"), 166);
        int height = number(call(info, "getHeight"), 65);
        out.put("size", Arrays.asList(Integer.valueOf(width), Integer.valueOf(height)));
        out.put("margin", Integer.valueOf(MARGIN));
        handlerWidth = width;
        animProbed = false;
        anim = null;
        animBox = null;

        Canvas canvas;
        try {
            canvas = new Canvas(width + 2 * MARGIN, height + 2 * MARGIN);
        } catch (Throwable t) {
            warn(className + ": no framebuffer: " + t);
            out.put("status", "failed");
            return out;
        }
        List<Object> recipes = new ArrayList<Object>();
        Map<String, Integer> bySignature = new HashMap<String, Integer>();
        int[] failures = new int[1];
        try {
            Object loaded = loadAll(handler);
            int n = number(call(loaded, "numRecipes"), 0);
            if (n > 0) {
                out.put("mode", "all");
                for (int r = 0; r < n && r < MAX_RECIPES; r++) {
                    if (System.currentTimeMillis() > deadline) {
                        out.put("truncated", Boolean.TRUE);
                        break;
                    }
                    Map<String, Object> recipe = recipe(loaded, r, canvas, failures);
                    if (recipe != null) {
                        recipes.add(recipe);
                    }
                }
            } else {
                // Handlers that only answer item lookups: ask for every item of NEI's list, and keep
                // which items each distinct recipe was shown for.
                out.put("mode", "items");
                Method lookup = method(handler, "getRecipeHandler", String.class, Object[].class);
                for (ItemStack stack : itemList) {
                    if (lookup == null || recipes.size() >= MAX_RECIPES) {
                        break;
                    }
                    if (System.currentTimeMillis() > deadline) {
                        out.put("truncated", Boolean.TRUE);
                        break;
                    }
                    Object h;
                    try {
                        h = lookup.invoke(handler, "item", new Object[] { stack });
                    } catch (Throwable t) {
                        failures[0]++;
                        continue;
                    }
                    int count = number(call(h, "numRecipes"), 0);
                    for (int r = 0; r < count; r++) {
                        String signature = signature(h, r);
                        Integer at = bySignature.get(signature);
                        if (at == null) {
                            Map<String, Object> recipe = recipe(h, r, canvas, failures);
                            if (recipe == null) {
                                continue;
                            }
                            at = Integer.valueOf(recipes.size());
                            bySignature.put(signature, at);
                            recipes.add(recipe);
                        }
                        @SuppressWarnings("unchecked")
                        Map<String, Object> recipe = (Map<String, Object>) recipes.get(at.intValue());
                        listOf(recipe, "for").add(Integer.valueOf(itemId(stack)));
                    }
                }
            }
        } catch (Throwable t) {
            warn(className + ": " + t);
        } finally {
            canvas.delete();
        }
        if (failures[0] > 0) {
            warn(className + ": " + failures[0] + " recipes failed to capture");
        }
        out.put("status", recipes.isEmpty() ? (failures[0] > 0 ? "failed" : "empty") : "captured");
        if (anim != null) {
            out.put("anim", anim);
        }
        out.put("recipes", recipes);
        return out;
    }

    /** TemplateRecipeHandler.getAllRecipeHandler, or a new instance asked for its own overlay id. */
    private Object loadAll(Object handler) {
        Object all = call(handler, "getAllRecipeHandler");
        if (number(call(all, "numRecipes"), 0) > 0) {
            return all;
        }
        Object fresh = call(handler, "newInstance");
        Object id = call(handler, "getOverlayIdentifier");
        Method load = method(fresh, "loadCraftingRecipes", String.class, Object[].class);
        if (fresh != null && id != null && load != null) {
            try {
                load.invoke(fresh, String.valueOf(id), new Object[0]);
                return fresh;
            } catch (Throwable ignored) {
            }
        }
        return all;
    }

    // ------------------------------------------------------------------------------------- one recipe

    private Map<String, Object> recipe(Object h, int r, Canvas canvas, int[] failures) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        List<Object> stacks = new ArrayList<Object>();
        List<Object> custom = new ArrayList<Object>();
        try {
            addStacks(stacks, custom, call(h, "getIngredientStacks", Integer.valueOf(r)), 0);
            addStacks(stacks, custom, call(h, "getResultStack", Integer.valueOf(r)), 1);
            addStacks(stacks, custom, call(h, "getOtherStacks", Integer.valueOf(r)), 2);
        } catch (Throwable t) {
            failures[0]++;
            return null;
        }
        try {
            addTanks(stacks, h, r);
        } catch (Throwable t) {
            warnOnce("tanks: " + t);
        }
        out.put("s", stacks);

        Minecraft mc = Minecraft.getMinecraft();
        FontRenderer realFont = mc.fontRenderer;
        Object guiDrawFont = staticField("codechicken.lib.gui.GuiDraw", "fontRenderer");
        if (recorder == null) {
            try {
                recorder = new RecordingFontRenderer(mc, realFont);
            } catch (Throwable t) {
                failures[0]++;
                return null;
            }
        }
        recorder.lines.clear();
        List<Object> text = new ArrayList<Object>();
        try {
            mc.fontRenderer = recorder;
            setStatic("codechicken.lib.gui.GuiDraw", "fontRenderer", recorder);
            Field ticks = cycleTicks(h);
            if (!animProbed) {
                animProbed = true;
                if (ticks != null) {
                    try {
                        probe(h, r, canvas, ticks);
                    } catch (Throwable t) {
                        warnOnce("animation: " + t);
                        anim = null;
                        animBox = null;
                    }
                }
                recorder.lines.clear();
            }
            setTicks(h, ticks, 0);
            int bg = canvas.draw(() -> {
                call(h, "drawBackground", Integer.valueOf(r));
                if (!custom.isEmpty()) {
                    RenderHelper.enableGUIStandardItemLighting();
                    for (Object p : custom) {
                        call(p, "draw", Integer.valueOf(-1000), Integer.valueOf(-1000));
                    }
                    RenderHelper.disableStandardItemLighting();
                }
            });
            addText(text, recorder, 0);
            byte[] front = canvas.render(() -> call(h, "drawForeground", Integer.valueOf(r)));
            if (animBox != null) {
                cut(front, canvas.width, animBox, false);
            }
            int fg = canvas.store(front);
            addText(text, recorder, 1);
            if (bg >= 0) out.put("bg", Integer.valueOf(bg));
            if (fg >= 0) out.put("fg", Integer.valueOf(fg));
        } catch (Throwable t) {
            failures[0]++;
        } finally {
            mc.fontRenderer = realFont;
            setStatic("codechicken.lib.gui.GuiDraw", "fontRenderer", guiDrawFont);
        }
        if (!text.isEmpty()) {
            out.put("t", text);
        }
        return out;
    }

    /** Text lines: [text, x, y, colour, shadow, layer (0 background, 1 foreground)]. */
    private static void addText(List<Object> out, RecordingFontRenderer recorder, int layer) {
        for (RecordingFontRenderer.Line line : recorder.lines) {
            List<Object> l = new ArrayList<Object>();
            l.add(line.text);
            l.add(Integer.valueOf(line.x));
            l.add(Integer.valueOf(line.y));
            l.add(Integer.valueOf(line.color));
            l.add(Integer.valueOf(line.shadow ? 1 : 0));
            l.add(Integer.valueOf(layer));
            out.add(l);
        }
        recorder.lines.clear();
    }

    /**
     * Positioned stacks: x, y, w, h, role (0 ingredient, 1 result, 2 other), item ids (the
     * permutations NEI cycles through), chance out of 10000 when not always, and d = 1 for
     * PositionedStack subclasses that draw themselves (tanks and the like), which are pictured in
     * the background layer instead of drawn as items.
     */
    private void addStacks(List<Object> out, List<Object> custom, Object value, int role) {
        for (Object p : iterable(value)) {
            if (p == null) {
                continue;
            }
            Map<String, Object> s = new LinkedHashMap<String, Object>();
            s.put("x", Integer.valueOf(number(field(p, "relx"), 0)));
            s.put("y", Integer.valueOf(number(field(p, "rely"), 0)));
            int w = number(field(p, "width"), 16), hgt = number(field(p, "height"), 16);
            if (w != 16 || hgt != 16) {
                s.put("w", Integer.valueOf(w));
                s.put("h", Integer.valueOf(hgt));
            }
            s.put("r", Integer.valueOf(role));
            List<Object> ids = new ArrayList<Object>();
            Object perms = field(p, "items");
            for (Object o : iterable(perms)) {
                if (o instanceof ItemStack) {
                    int id = itemId((ItemStack) o);
                    if (id >= 0) ids.add(Integer.valueOf(id));
                }
            }
            if (ids.isEmpty() && field(p, "item") instanceof ItemStack) {
                int id = itemId((ItemStack) field(p, "item"));
                if (id >= 0) ids.add(Integer.valueOf(id));
            }
            s.put("i", ids);
            Object current = field(p, "item");
            if (current instanceof ItemStack && ids.size() > 1) {
                int id = itemId((ItemStack) current);
                int at = ids.indexOf(Integer.valueOf(id));
                if (at > 0) s.put("a", Integer.valueOf(at));
            }
            int chance = number(call(p, "getChance"), 10000);
            if (chance > 0 && chance < 10000) {
                s.put("c", Integer.valueOf(chance));
            }
            Object tip = call(p, "getTooltip");
            if (tip instanceof List && !((List<?>) tip).isEmpty()) {
                List<Object> lines = new ArrayList<Object>();
                for (Object l : (List<?>) tip) lines.add(String.valueOf(l));
                s.put("tip", lines);
            }
            if (!"codechicken.nei.PositionedStack".equals(p.getClass().getName())) {
                s.put("cls", p.getClass().getSimpleName());
                if (overridesDraw(p.getClass())) {
                    s.put("d", Integer.valueOf(1));
                    custom.add(p);
                }
            }
            out.add(s);
        }
    }

    private static boolean overridesDraw(Class<?> c) {
        for (; c != null && !"codechicken.nei.PositionedStack".equals(c.getName()); c = c.getSuperclass()) {
            try {
                c.getDeclaredMethod("draw", int.class, int.class);
                return true;
            } catch (NoSuchMethodException ignored) {
            }
        }
        return false;
    }

    // ------------------------------------------------------------------------------------- fluid tanks

    /**
     * Fluid tanks of the recipe (CachedRecipe.getFluidTanks()): each one's area, its fluids (the
     * permutations of a tank that cycles) and the tooltip it gives. A tank right of every ingredient
     * (or, without ingredients, in the right half) is a result, any other one an ingredient. The
     * handler draws its tanks, so they are pictured, not drawn as items.
     */
    private void addTanks(List<Object> out, Object h, int r) {
        Object list = field(h, "arecipes");
        if (!(list instanceof List) || r >= ((List<?>) list).size()) {
            return;
        }
        Object tanks = call(((List<?>) list).get(r), "getFluidTanks");
        if (tanks == null) {
            return;
        }
        int inputsRight = -1;
        for (Object o : out) {
            @SuppressWarnings("unchecked")
            Map<String, Object> s = (Map<String, Object>) o;
            if (Integer.valueOf(0).equals(s.get("r"))) {
                int w = s.get("w") instanceof Integer ? ((Integer) s.get("w")).intValue() : 16;
                inputsRight = Math.max(inputsRight, ((Integer) s.get("x")).intValue() + w);
            }
        }
        for (Object tank : iterable(tanks)) {
            Object pos = field(tank, "position");
            if (!(pos instanceof java.awt.Rectangle)) {
                continue;
            }
            java.awt.Rectangle rect = (java.awt.Rectangle) pos;
            List<FluidStack> fluids = new ArrayList<FluidStack>();
            Object many = field(tank, "tanks");
            if (many instanceof Object[]) {
                for (Object t : (Object[]) many) addFluid(fluids, t);
            }
            if (fluids.isEmpty()) {
                addFluid(fluids, field(tank, "tank"));
                addFluid(fluids, field(tank, "fluid"));
            }
            List<Object> ids = new ArrayList<Object>();
            for (FluidStack f : fluids) {
                int id = fluidId(f);
                if (id >= 0 && !ids.contains(Integer.valueOf(id))) ids.add(Integer.valueOf(id));
            }
            if (ids.isEmpty()) {
                continue;
            }
            int centre = rect.x + rect.width / 2;
            boolean input = inputsRight >= 0 ? centre <= inputsRight : centre < handlerWidth / 2;
            Map<String, Object> s = new LinkedHashMap<String, Object>();
            s.put("x", Integer.valueOf(rect.x));
            s.put("y", Integer.valueOf(rect.y));
            s.put("w", Integer.valueOf(rect.width));
            s.put("h", Integer.valueOf(rect.height));
            s.put("r", Integer.valueOf(input ? 0 : 1));
            s.put("i", ids);
            Object tip = call(tank, "handleTooltip", new ArrayList<String>());
            if (tip instanceof List && !((List<?>) tip).isEmpty()) {
                List<Object> lines = new ArrayList<Object>();
                for (Object l : (List<?>) tip) lines.add(String.valueOf(l));
                s.put("name", lines.get(0));
                if (lines.size() > 1) s.put("tip", lines.subList(1, lines.size()));
            }
            s.put("cls", tank.getClass().getSimpleName());
            s.put("d", Integer.valueOf(1));
            out.add(s);
        }
    }

    private static void addFluid(List<FluidStack> out, Object o) {
        if (o != null && !(o instanceof FluidStack)) {
            o = call(o, "getFluid");
        }
        if (o instanceof FluidStack && ((FluidStack) o).getFluid() != null && ((FluidStack) o).amount > 0) {
            out.add((FluidStack) o);
        }
    }

    private int fluidId(FluidStack fluid) {
        String key = "fluid:" + fluid.getFluid().getName() + "x" + fluid.amount;
        Integer id = itemIds.get(key);
        if (id == null) {
            Map<String, Object> item = resources.fluid(fluid);
            id = Integer.valueOf(item == null ? -1 : items.size());
            if (item != null) {
                items.add(item);
            }
            itemIds.put(key, id);
        }
        return id.intValue();
    }

    // ------------------------------------------------------------------------------------- animation

    /** TemplateRecipeHandler.cycleticks, the counter drawProgressBar reads. */
    private static Field cycleTicks(Object h) {
        for (Class<?> c = h.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField("cycleticks");
                if (f.getType() == int.class) {
                    f.setAccessible(true);
                    return f;
                }
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    private static void setTicks(Object h, Field f, int ticks) {
        if (f == null) return;
        try {
            f.setInt(h, ticks);
        } catch (Throwable ignored) {
        }
    }

    /**
     * Draws the foreground of the handler's first recipe at a few ticks; if it changes, over
     * PROBE_TICKS ticks, and when that repeats with a period, keeps the area that changes and a
     * picture of it at every tick within the period where it changes ("anim": period, keys, pics).
     */
    private void probe(Object h, int r, Canvas canvas, Field ticks) throws Exception {
        Runnable front = () -> call(h, "drawForeground", Integer.valueOf(r));
        String first = null;
        boolean moves = false;
        for (int t : new int[] { 0, 5, 11, 17, 23, 37, 61 }) {
            setTicks(h, ticks, t);
            String hash = sha1(canvas.render(front));
            if (first == null) first = hash;
            else if (!hash.equals(first)) moves = true;
        }
        if (!moves) {
            return;
        }
        String[] hashes = new String[PROBE_TICKS];
        Map<String, byte[]> frames = new HashMap<String, byte[]>();
        for (int t = 0; t < PROBE_TICKS; t++) {
            setTicks(h, ticks, t);
            byte[] b = canvas.render(front);
            hashes[t] = sha1(b);
            if (!frames.containsKey(hashes[t])) frames.put(hashes[t], b);
        }
        int period = -1;
        search:
        for (int p = 1; p <= PROBE_TICKS / 2; p++) {
            for (int t = p; t < PROBE_TICKS; t++) {
                if (!hashes[t].equals(hashes[t - p])) continue search;
            }
            period = p;
            break;
        }
        if (period < 0) {
            warnOnce("foreground changes without repeating; drawn still");
            return;
        }
        List<Integer> keys = new ArrayList<Integer>();
        for (int t = 0; t < period; t++) {
            if (t == 0 || !hashes[t].equals(hashes[t - 1])) keys.add(Integer.valueOf(t));
        }
        if (keys.size() < 2) {
            return;
        }
        if (keys.size() > MAX_KEYS) {
            List<Integer> fewer = new ArrayList<Integer>();
            for (int k = 0; k < MAX_KEYS; k++) fewer.add(keys.get(k * keys.size() / MAX_KEYS));
            keys = fewer;
        }
        // The area where any frame of the period differs from the first.
        byte[] base = frames.get(hashes[0]);
        int w = canvas.width, hgt = canvas.height;
        int x0 = w, y0 = hgt, x1 = -1, y1 = -1;
        for (int t = 1; t < period; t++) {
            if (hashes[t].equals(hashes[t - 1])) continue;
            byte[] f = frames.get(hashes[t]);
            for (int y = 0; y < hgt; y++) {
                for (int x = 0; x < w; x++) {
                    int i = (y * w + x) * 4;
                    if (f[i] != base[i] || f[i + 1] != base[i + 1] || f[i + 2] != base[i + 2] || f[i + 3] != base[i + 3]) {
                        x0 = Math.min(x0, x);
                        y0 = Math.min(y0, y);
                        x1 = Math.max(x1, x);
                        y1 = Math.max(y1, y);
                    }
                }
            }
        }
        if (x1 < 0) {
            return;
        }
        int[] box = new int[] { x0, y0, x1, y1 };
        List<Object> pics = new ArrayList<Object>();
        for (Integer k : keys) {
            byte[] f = frames.get(hashes[k.intValue()]).clone();
            cut(f, w, box, true);
            pics.add(Integer.valueOf(canvas.store(f)));
        }
        Map<String, Object> a = new LinkedHashMap<String, Object>();
        a.put("period", Integer.valueOf(period));
        a.put("keys", keys);
        a.put("pics", pics);
        anim = a;
        animBox = box;
    }

    /** Clears the pixels inside the box (keep = false) or outside it (keep = true). */
    private static void cut(byte[] rgba, int width, int[] box, boolean keep) {
        int height = rgba.length / 4 / width;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                boolean in = x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
                if (in != keep) {
                    int i = (y * width + x) * 4;
                    rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
                }
            }
        }
    }

    /** The recipe's stacks, to recognise the same recipe coming back from another item's lookup. */
    private static String signature(Object h, int r) {
        StringBuilder b = new StringBuilder();
        for (String m : new String[] { "getIngredientStacks", "getResultStack", "getOtherStacks" }) {
            b.append('|');
            for (Object p : iterable(call(h, m, Integer.valueOf(r)))) {
                if (p == null) continue;
                b.append(field(p, "relx")).append(',').append(field(p, "rely")).append(':');
                for (Object o : iterable(field(p, "items"))) {
                    if (o instanceof ItemStack) b.append(stackKey((ItemStack) o)).append(';');
                }
            }
        }
        return b.toString();
    }

    private int itemId(ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return -1;
        }
        String key = stackKey(stack);
        Integer id = itemIds.get(key);
        if (id == null) {
            ItemStack s = stack;
            if (s.stackSize <= 0) {
                s = stack.copy();
                s.stackSize = 1;
            }
            Map<String, Object> item = resources.item(s);
            id = Integer.valueOf(item == null ? -1 : items.size());
            if (item != null) {
                items.add(item);
            }
            itemIds.put(key, id);
        }
        return id.intValue();
    }

    private static String stackKey(ItemStack stack) {
        Object name = Item.itemRegistry.getNameForObject(stack.getItem());
        return name + "@" + stack.getItemDamage() + "x" + stack.stackSize
            + (stack.stackTagCompound == null ? "" : "#" + stack.stackTagCompound);
    }

    // ------------------------------------------------------------------------------------- pictures

    /** An off-screen framebuffer the size of a recipe (plus the margin), drawn at GUI scale 1. */
    private final class Canvas {

        final int width;
        final int height;
        final Framebuffer fb;
        final ByteBuffer pixels;

        Canvas(int width, int height) {
            this.width = width;
            this.height = height;
            this.fb = new Framebuffer(width, height, true);
            this.pixels = BufferUtils.createByteBuffer(width * height * 4);
        }

        void delete() {
            fb.deleteFramebuffer();
        }

        /** Draws into a cleared canvas and returns the picture's id, or -1 when nothing was drawn. */
        int draw(Runnable drawing) throws Exception {
            return store(render(drawing));
        }

        /** Draws into a cleared canvas and returns its pixels (RGBA, rows bottom-up). */
        byte[] render(Runnable drawing) throws Exception {
            GL11.glPushAttrib(GL11.GL_ALL_ATTRIB_BITS);
            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPushMatrix();
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPushMatrix();
            try {
                fb.bindFramebuffer(true);
                GL11.glViewport(0, 0, width, height);
                GL11.glClearColor(0.0F, 0.0F, 0.0F, 0.0F);
                GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glLoadIdentity();
                GL11.glOrtho(0.0D, width, height, 0.0D, 1000.0D, 3000.0D);
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glLoadIdentity();
                GL11.glTranslatef(MARGIN, MARGIN, -2000.0F);
                GL11.glEnable(GL11.GL_TEXTURE_2D);
                GL11.glDisable(GL11.GL_LIGHTING);
                GL11.glEnable(GL11.GL_ALPHA_TEST);
                GL11.glEnable(GL11.GL_BLEND);
                // Keep the alpha of what is drawn over the transparent canvas, so the picture can be
                // laid over the recipe window on the site.
                OpenGlHelper.glBlendFunc(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA, GL11.GL_ONE, GL11.GL_ONE_MINUS_SRC_ALPHA);
                GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
                drawing.run();
                GL11.glFlush();
                pixels.clear();
                GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixels);
            } finally {
                fb.unbindFramebuffer();
                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glPopMatrix();
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glPopMatrix();
                GL11.glPopAttrib();
            }
            byte[] bytes = new byte[width * height * 4];
            pixels.get(bytes);
            return bytes;
        }

        /** Stores a picture once and returns its id, or -1 when it is empty. */
        int store(byte[] bytes) throws Exception {
            boolean any = false;
            for (int i = 3; i < bytes.length; i += 4) {
                if (bytes[i] != 0) {
                    any = true;
                    break;
                }
            }
            if (!any) {
                return -1;
            }
            String hash = sha1(bytes);
            Integer id = imageIds.get(hash);
            if (id != null) {
                return id.intValue();
            }
            String file = hash.substring(0, 16) + ".png";
            if (imageDir != null) {
                ImageIO.write(image(bytes, width, height), "png", new File(imageDir, file));
            }
            id = Integer.valueOf(images.size());
            images.add(file);
            imageIds.put(hash, id);
            return id.intValue();
        }
    }

    private static BufferedImage image(byte[] rgba, int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int i = ((height - 1 - y) * width + x) * 4;
                int r = rgba[i] & 0xFF, g = rgba[i + 1] & 0xFF, b = rgba[i + 2] & 0xFF, a = rgba[i + 3] & 0xFF;
                image.setRGB(x, y, (a << 24) | (r << 16) | (g << 8) | b);
            }
        }
        return image;
    }

    // ------------------------------------------------------------------------------------- helpers

    private static String sha1(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-1").digest(data);
        StringBuilder b = new StringBuilder();
        for (byte x : d) b.append(String.format("%02x", Byte.valueOf(x)));
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> listOf(Map<String, Object> map, String name) {
        Object list = map.get(name);
        if (!(list instanceof List)) {
            list = new ArrayList<Object>();
            map.put(name, list);
        }
        return (List<Object>) list;
    }

    private static int number(Object v, int fallback) {
        return v instanceof Number ? ((Number) v).intValue() : fallback;
    }

    private static Method method(Object target, String name, Class<?>... types) {
        if (target == null) return null;
        try {
            return target.getClass().getMethod(name, types);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Class<?> classOrNull(String name) {
        try {
            return Class.forName(name);
        } catch (Throwable t) {
            return null;
        }
    }

    private static void setStatic(String className, String name, Object value) {
        try {
            Field f = Class.forName(className).getDeclaredField(name);
            f.setAccessible(true);
            f.set(null, value);
        } catch (Throwable ignored) {
        }
    }

    private final Set<String> warnedOnce = new HashSet<String>();

    /** A warning shown once per kind of problem, however many handlers have it. */
    private void warnOnce(String message) {
        if (warnedOnce.add(message)) {
            warn(message);
        }
    }

    private void warn(String message) {
        if (warnings.size() < 80) {
            warnings.add(message);
        }
        GtnhCalcOracleMod.LOG.warn("NEI generic capture: {}", message);
    }
}
