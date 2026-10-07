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
 * Everything that draws runs on the client thread (ClientThread). Reflection only.
 */
public final class NeiGenericCapture {

    /** Space around the recipe area in the pictures, for handlers that draw outside it. */
    public static final int MARGIN = 16;
    private static final int MAX_RECIPES = 20000;

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
            int fg = canvas.draw(() -> call(h, "drawForeground", Integer.valueOf(r)));
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

    private void warn(String message) {
        if (warnings.size() < 80) {
            warnings.add(message);
        }
        GtnhCalcOracleMod.LOG.warn("NEI generic capture: {}", message);
    }
}
