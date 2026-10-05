package dev.gtnhplanner.calcoracle.icons;

import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.imageio.ImageIO;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.renderer.RenderHelper;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.ITextureObject;
import net.minecraft.client.renderer.texture.SimpleTexture;
import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTBase;
import net.minecraft.nbt.NBTTagByte;
import net.minecraft.nbt.NBTTagByteArray;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagDouble;
import net.minecraft.nbt.NBTTagFloat;
import net.minecraft.nbt.NBTTagInt;
import net.minecraft.nbt.NBTTagIntArray;
import net.minecraft.nbt.NBTTagList;
import net.minecraft.nbt.NBTTagLong;
import net.minecraft.nbt.NBTTagShort;
import net.minecraft.nbt.NBTTagString;
import net.minecraft.util.ResourceLocation;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;

/**
 * Renders every item stack the questbook shows, exactly as the quest stores it (NBT included), so the
 * site can show Tinkers tools, wands and other NBT-defined items the recipe export never meets.
 *
 * <p>Input: {@code -Dgtnh.oracle.questStacks=<file>}, one JSON object per line:
 * {@code {"k": key, "id": registry name, "dmg": damage, "tag": BetterQuesting typed NBT JSON text}}.
 *
 * <p>Output in {@code <iconDir>/quest/}: one PNG per stack and {@code manifest.json}. A PNG is a
 * vertical strip of 256px layers:
 * <ul>
 * <li>frames: the item as the GUI draws it, one layer per animation frame ({@code ticks} gives each
 * frame's length in game ticks). Without {@code lit} the frames are the finished icon.</li>
 * <li>with {@code lit} (3D items lit by the GUI item lights), the frames are the unlit colours U, and
 * one more layer D holds each light's diffuse factor (red: light 0, green: light 1, 0-255 for 0-1),
 * so the site can relight the item the way BetterQuesting's scaled drawing does
 * (colour = min(T, U * (0.4 + 0.6 * (c0 * D0 + c1 * D1)))). With {@code t}, a last layer T holds
 * the texture colours before the vertex tint (the cap of that min); otherwise T equals U.</li>
 * <li>{@code glint}: the enchantment glint was taken out of the layers; the site draws it.</li>
 * </ul>
 */
public final class QuestStackIconExporter {

    private static final int SIZE = Integer.getInteger("gtnh.oracle.iconSize", 256);
    private static final int CANVAS = 32;
    private static final int ITEM_XY = (CANVAS - 16) / 2;
    /** Ticks between the two renders that decide whether a stack is animated. */
    private static final int ANIMATION_PROBE_TICKS = 7;
    /** Ticks recorded for an animated stack; the loop period is searched up to half of this. */
    private static final int ANIMATION_RECORD_TICKS = Integer.getInteger("gtnh.oracle.animationTicks", 96);
    private static final int MAX_ANIMATION_FRAMES = Integer.getInteger("gtnh.oracle.maxAnimationFrames", 48);
    private static final long FRAME_BUDGET_MS = 250L;
    private static final ResourceLocation GLINT = new ResourceLocation("textures/misc/enchanted_item_glint.png");

    private enum Lights {
        /** RenderHelper.enableGUIStandardItemLighting as the GUI sets it. */
        GUI,
        /** Every lit surface at full colour: ambient 1, no diffuse. */
        UNLIT,
        LIGHT0,
        LIGHT1,
        /** Huge ambient: colour clamps to the texture colour, before any vertex tint. */
        TEXTURE
    }

    private static Framebuffer framebuffer;
    private static ByteBuffer readback;
    private static DynamicTexture blankGlint;
    private static final FloatBuffer LIGHT_BUFFER = BufferUtils.createFloatBuffer(4);

    private QuestStackIconExporter() {}

    /** Runs the quest stack pass if a stack list was given, then {@code after}. */
    public static void exportThen(Runnable after) {
        String path = System.getProperty("gtnh.oracle.questStacks");
        Minecraft minecraft = Minecraft.getMinecraft();
        if (path == null || path.trim().isEmpty() || minecraft == null) {
            after.run();
            return;
        }
        List<JsonObject> entries = new ArrayList<JsonObject>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(path), "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (!line.isEmpty()) entries.add(JsonParser.parseString(line).getAsJsonObject());
            }
        } catch (Throwable t) {
            GtnhCalcOracleMod.LOG.error("Could not read the quest stack list " + path + "; skipping quest icons.", t);
            after.run();
            return;
        }
        minecraft.displayGuiScreen(new ExportScreen(entries, after));
    }

    private static final class ExportScreen extends GuiScreen {

        private final List<JsonObject> entries;
        private final Runnable after;
        private final Map<String, String> manifest = new LinkedHashMap<String, String>();
        private final File outDir = new File(ClientItemStackIconRenderer.iconDir(), "quest");
        private int index;
        private int rendered, lit, animated, glint, noItem, invisible, failed;
        private boolean finished;

        private ExportScreen(List<JsonObject> entries, Runnable after) {
            this.entries = entries;
            this.after = after;
            outDir.mkdirs();
            GtnhCalcOracleMod.LOG.info("GTNH quest stack icons started: " + entries.size() + " stacks, " + SIZE + "px.");
        }

        @Override
        public void drawScreen(int mouseX, int mouseY, float partialTicks) {
            if (finished) return;
            long start = System.currentTimeMillis();
            while (index < entries.size() && System.currentTimeMillis() - start < FRAME_BUDGET_MS) {
                JsonObject entry = entries.get(index++);
                String key = entry.has("k") ? entry.get("k").getAsString() : "?";
                try {
                    process(key, entry);
                } catch (Throwable t) {
                    failed++;
                    ClientItemStackIconRenderer.resetTessellator();
                    if (failed <= 50) GtnhCalcOracleMod.LOG.warn("Quest stack icon failed for " + key + ": " + t);
                }
                if (index % 256 == 0 || index == entries.size()) {
                    GtnhCalcOracleMod.LOG.info(
                        "GTNH quest stack icon progress " + index + "/" + entries.size() + " (rendered " + rendered
                            + ", lit " + lit + ", animated " + animated + ", glint " + glint + ", no item " + noItem
                            + ", invisible " + invisible + ", failed " + failed + ").");
                }
            }
            if (index >= entries.size()) {
                finished = true;
                writeManifest();
                GtnhCalcOracleMod.LOG.info("GTNH quest stack icons finished.");
                after.run();
            }
        }

        private void process(String key, JsonObject entry) throws Exception {
            ItemStack stack = buildStack(entry);
            if (stack == null) {
                noItem++;
                return;
            }
            String name;
            try {
                name = stack.getDisplayName();
            } catch (Throwable t) {
                name = null;
            }

            Minecraft mc = Minecraft.getMinecraft();
            TextureManager textures = mc.getTextureManager();
            int[] withGlint = render(stack, Lights.GUI);
            boolean mayGlint = hasEffect(stack);
            boolean blank = false;
            ITextureObject realGlint = textures.getTexture(GLINT);
            try {
                int[] base = withGlint;
                if (mayGlint) {
                    // Same render with an invisible glint texture: any difference is the glint.
                    if (blankGlint == null) {
                        blankGlint = new DynamicTexture(1, 1);
                        blankGlint.updateDynamicTexture();
                    }
                    textures.loadTexture(GLINT, blankGlint);
                    blank = true;
                    base = render(stack, Lights.GUI);
                }
                if (!visible(base)) {
                    invisible++;
                    record(key, name, null);
                    return;
                }
                boolean hasGlint = mayGlint && !same(withGlint, base);

                List<int[]> extra = new ArrayList<int[]>();
                boolean isLit = false, hasT = false;
                int[] unlit = render(stack, Lights.UNLIT);
                if (!same(unlit, base)) {
                    int[] d = diffuseLayer(unlit, render(stack, Lights.LIGHT0), render(stack, Lights.LIGHT1));
                    int[] tex = render(stack, Lights.TEXTURE);
                    if (!hasGlint && reconstructs(base, unlit, d, tex)) {
                        isLit = true;
                        extra.add(d);
                        if (!same(tex, unlit)) {
                            hasT = true;
                            extra.add(tex);
                        }
                    }
                }
                boolean baked = false;
                if (hasGlint && !isLit && !same(unlit, base)) {
                    // A lit item with a glint: the site can't relight under a glint, so keep this one baked.
                    hasGlint = false;
                    baked = true;
                    base = withGlint;
                }

                Lights setup = isLit ? Lights.UNLIT : Lights.GUI;
                List<int[]> frames = new ArrayList<int[]>();
                List<Integer> ticks = new ArrayList<Integer>();
                frames.add(isLit ? unlit : base);
                ticks.add(Integer.valueOf(1));
                // A baked glint moves with time, which would look like an animation.
                if (!baked) recordAnimation(stack, setup, frames, ticks);

                List<int[]> layers = new ArrayList<int[]>(frames);
                layers.addAll(extra);
                String file = ClientItemStackIconRenderer.sha1(key).substring(0, 16) + ".png";
                writeStrip(new File(outDir, file), layers);

                StringBuilder json = new StringBuilder();
                json.append("{\"name\":").append(jsonString(name)).append(",\"icon\":").append(jsonString("quest/" + file));
                if (frames.size() > 1) {
                    json.append(",\"frames\":").append(frames.size()).append(",\"ticks\":[");
                    for (int i = 0; i < ticks.size(); i++) json.append(i > 0 ? "," : "").append(ticks.get(i));
                    json.append(']');
                    animated++;
                }
                if (isLit) {
                    json.append(",\"lit\":1");
                    lit++;
                }
                if (hasT) json.append(",\"t\":1");
                if (hasGlint) {
                    json.append(",\"glint\":1");
                    glint++;
                }
                json.append('}');
                manifest.put(key, json.toString());
                rendered++;
            } finally {
                if (blank && realGlint != null) textures.loadTexture(GLINT, realGlint);
                else if (blank) textures.loadTexture(GLINT, new SimpleTexture(GLINT));
            }
        }

        private void record(String key, String name, String icon) {
            manifest.put(key, "{\"name\":" + jsonString(name) + (icon != null ? ",\"icon\":" + jsonString(icon) : "") + "}");
        }

        private void writeManifest() {
            File file = new File(outDir, "manifest.json");
            try (Writer writer = new OutputStreamWriter(new java.io.FileOutputStream(file), "UTF-8")) {
                writer.write("{\n");
                int i = 0;
                for (Map.Entry<String, String> e : manifest.entrySet()) {
                    writer.write((i++ > 0 ? ",\n" : "") + jsonString(e.getKey()) + ":" + e.getValue());
                }
                writer.write("\n}\n");
            } catch (Throwable t) {
                GtnhCalcOracleMod.LOG.error("Could not write the quest stack manifest.", t);
            }
        }
    }

    // ---------------------------------------------------------------- animation

    /**
     * Steps the texture animations one game tick at a time. If the stack changes within a few ticks,
     * records {@link #ANIMATION_RECORD_TICKS} ticks, finds the shortest loop and keeps each distinct
     * frame with its length. Replaces the single frame in {@code frames} when animated.
     */
    private static void recordAnimation(ItemStack stack, Lights setup, List<int[]> frames, List<Integer> ticks)
        throws Exception {
        TextureManager textures = Minecraft.getMinecraft().getTextureManager();
        for (int i = 0; i < ANIMATION_PROBE_TICKS; i++) textures.tick();
        int[] probe = render(stack, setup);
        if (same(probe, frames.get(0))) return;

        List<int[]> seq = new ArrayList<int[]>();
        seq.add(probe);
        for (int i = 1; i < ANIMATION_RECORD_TICKS; i++) {
            textures.tick();
            seq.add(render(stack, setup));
        }
        int period = seq.size();
        for (int p = 1; p <= seq.size() / 2; p++) {
            boolean loops = true;
            for (int i = 0; i + p < seq.size() && loops; i++) loops = same(seq.get(i), seq.get(i + p));
            if (loops) {
                period = p;
                break;
            }
        }
        List<int[]> outFrames = new ArrayList<int[]>();
        List<Integer> outTicks = new ArrayList<Integer>();
        for (int i = 0; i < period; i++) {
            int[] f = seq.get(i);
            if (!outFrames.isEmpty() && same(outFrames.get(outFrames.size() - 1), f)) {
                int last = outTicks.size() - 1;
                outTicks.set(last, Integer.valueOf(outTicks.get(last).intValue() + 1));
            } else {
                outFrames.add(f);
                outTicks.add(Integer.valueOf(1));
            }
        }
        if (outFrames.size() < 2 || outFrames.size() > MAX_ANIMATION_FRAMES) return; // static, or changing by time
        frames.clear();
        frames.addAll(outFrames);
        ticks.clear();
        ticks.addAll(outTicks);
    }

    // ---------------------------------------------------------------- lighting layers

    /** Diffuse factor of each GUI item light per pixel, from the single-light renders and the unlit one. */
    private static int[] diffuseLayer(int[] unlit, int[] light0, int[] light1) {
        int[] out = new int[unlit.length];
        for (int i = 0; i < unlit.length; i++) {
            int u = unlit[i];
            if ((u >>> 24) == 0) continue;
            int c = brightestChannelShift(u);
            int uc = (u >> c) & 255;
            int d0 = uc == 0 ? 0 : Math.min(255, Math.round(((light0[i] >> c) & 255) * 255F / uc));
            int d1 = uc == 0 ? 0 : Math.min(255, Math.round(((light1[i] >> c) & 255) * 255F / uc));
            out[i] = 0xFF000000 | (d0 << 16) | (d1 << 8);
        }
        return out;
    }

    private static int brightestChannelShift(int argb) {
        int r = (argb >> 16) & 255, g = (argb >> 8) & 255, b = argb & 255;
        return r >= g && r >= b ? 16 : g >= b ? 8 : 0;
    }

    /**
     * Checks that min(T, U * (0.4 + 0.6 * (D0 + D1))) gives back the GUI render, i.e. that the item is
     * lit only by the fixed GUI lights. Renderers that set up their own lighting fail this and keep
     * their ordinary icon.
     */
    private static boolean reconstructs(int[] gui, int[] unlit, int[] d, int[] tex) {
        long error = 0;
        int counted = 0, bad = 0;
        for (int i = 0; i < gui.length; i++) {
            if ((gui[i] >>> 24) == 0) continue;
            float light = 0.4F + 0.6F * (((d[i] >> 16) & 255) + ((d[i] >> 8) & 255)) / 255F;
            for (int c = 0; c <= 16; c += 8) {
                int expect = Math.min((tex[i] >> c) & 255, Math.round(((unlit[i] >> c) & 255) * light));
                int diff = Math.abs(expect - ((gui[i] >> c) & 255));
                error += diff;
                counted++;
                if (diff > 16) bad++;
            }
        }
        return counted > 0 && error <= 3L * counted && bad * 50 <= counted;
    }

    // ---------------------------------------------------------------- rendering

    /** Renders one stack the way the in-game GUI does, with the given lights, into ARGB pixels (top row first). */
    private static int[] render(ItemStack stack, Lights lights) {
        Minecraft mc = Minecraft.getMinecraft();
        if (framebuffer == null) {
            framebuffer = new Framebuffer(SIZE, SIZE, true);
            readback = BufferUtils.createByteBuffer(SIZE * SIZE * 4);
        }
        boolean projectionPushed = false, modelViewPushed = false;
        try {
            ClientItemStackIconRenderer.resetTessellator();
            framebuffer.bindFramebuffer(true);
            GL11.glViewport(0, 0, SIZE, SIZE);
            GL11.glClearColor(0F, 0F, 0F, 0F);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPushMatrix();
            projectionPushed = true;
            GL11.glLoadIdentity();
            GL11.glOrtho(0D, CANVAS, CANVAS, 0D, 1000D, 3000D);
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPushMatrix();
            modelViewPushed = true;
            GL11.glLoadIdentity();
            GL11.glTranslatef(0F, 0F, -2000F);

            ClientItemStackIconRenderer.forceNearestFiltering(mc);
            RenderHelper.enableGUIStandardItemLighting();
            setLights(lights);
            GL11.glEnable(GL12.GL_RESCALE_NORMAL);
            codechicken.nei.guihook.GuiContainerManager.drawItem(ITEM_XY, ITEM_XY, stack);
            RenderHelper.disableStandardItemLighting();
            GL11.glDisable(GL12.GL_RESCALE_NORMAL);
            ClientItemStackIconRenderer.resetTessellator();
            GL11.glFlush();
            readback.clear();
            GL11.glReadPixels(0, 0, SIZE, SIZE, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, readback);
        } finally {
            RenderHelper.disableStandardItemLighting();
            GL11.glDisable(GL12.GL_RESCALE_NORMAL);
            ClientItemStackIconRenderer.resetTessellator();
            if (modelViewPushed) {
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glPopMatrix();
            }
            if (projectionPushed) {
                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glPopMatrix();
            }
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            framebuffer.unbindFramebuffer();
        }
        int[] out = new int[SIZE * SIZE];
        for (int y = 0; y < SIZE; y++) {
            int row = (SIZE - 1 - y) * SIZE * 4;
            for (int x = 0; x < SIZE; x++) {
                int i = row + x * 4;
                out[y * SIZE + x] = ((readback.get(i + 3) & 255) << 24) | ((readback.get(i) & 255) << 16)
                    | ((readback.get(i + 1) & 255) << 8) | (readback.get(i + 2) & 255);
            }
        }
        return out;
    }

    /** Light parameters on top of the GUI item lighting (positions are kept, only strengths change). */
    private static void setLights(Lights lights) {
        if (lights == Lights.GUI) return;
        float ambient = lights == Lights.UNLIT ? 1F : lights == Lights.TEXTURE ? 64F : 0F;
        GL11.glLightModel(GL11.GL_LIGHT_MODEL_AMBIENT, color(ambient));
        GL11.glLight(GL11.GL_LIGHT0, GL11.GL_DIFFUSE, color(lights == Lights.LIGHT0 ? 1F : 0F));
        GL11.glLight(GL11.GL_LIGHT1, GL11.GL_DIFFUSE, color(lights == Lights.LIGHT1 ? 1F : 0F));
    }

    private static FloatBuffer color(float v) {
        LIGHT_BUFFER.clear();
        LIGHT_BUFFER.put(v).put(v).put(v).put(1F);
        LIGHT_BUFFER.flip();
        return LIGHT_BUFFER;
    }

    private static boolean hasEffect(ItemStack stack) {
        try {
            return stack.hasEffect(0) || stack.hasEffect(1);
        } catch (Throwable t) {
            return false;
        }
    }

    private static boolean same(int[] a, int[] b) {
        return java.util.Arrays.equals(a, b);
    }

    private static boolean visible(int[] px) {
        for (int p : px) {
            if ((p >>> 24) != 0) return !ClientItemStackIconRenderer.looksLikeMissingTexture(px);
        }
        return false;
    }

    private static void writeStrip(File file, List<int[]> layers) throws Exception {
        BufferedImage image = new BufferedImage(SIZE, SIZE * layers.size(), BufferedImage.TYPE_INT_ARGB);
        for (int i = 0; i < layers.size(); i++) image.setRGB(0, i * SIZE, SIZE, SIZE, layers.get(i), 0, SIZE);
        ImageIO.write(image, "png", file);
    }

    // ---------------------------------------------------------------- stacks from BetterQuesting JSON

    private static ItemStack buildStack(JsonObject entry) {
        Object item = Item.itemRegistry.getObject(entry.get("id").getAsString());
        if (!(item instanceof Item)) return null;
        ItemStack stack = new ItemStack((Item) item, 1, entry.has("dmg") ? entry.get("dmg").getAsInt() : 0);
        if (entry.has("tag")) {
            JsonElement tag = JsonParser.parseString(entry.get("tag").getAsString());
            if (tag.isJsonObject()) stack.setTagCompound(compound(tag.getAsJsonObject()));
        }
        return stack;
    }

    /** Port of BetterQuesting's NBTConverter.JSONtoNBT_Object for its typed keys ("name:type"). */
    static NBTTagCompound compound(JsonObject json) {
        NBTTagCompound tag = new NBTTagCompound();
        for (Map.Entry<String, JsonElement> e : json.entrySet()) {
            String key = e.getKey();
            String name = key;
            byte type = 0;
            int colon = key.lastIndexOf(':');
            if (colon >= 0) {
                try {
                    type = Byte.parseByte(key.substring(colon + 1));
                    name = key.substring(0, colon);
                } catch (NumberFormatException ignored) {
                    type = 0;
                }
            }
            tag.setTag(name, element(e.getValue(), type));
        }
        return tag;
    }

    private static NBTBase element(JsonElement json, byte declared) {
        byte type = declared > 0 ? declared : guessType(json);
        switch (type) {
            case 1:
                if (json.isJsonPrimitive() && json.getAsJsonPrimitive().isBoolean()) {
                    return new NBTTagByte((byte) (json.getAsBoolean() ? 1 : 0));
                }
                return new NBTTagByte(json.getAsNumber().byteValue());
            case 2:
                return new NBTTagShort(json.getAsNumber().shortValue());
            case 3:
                return new NBTTagInt(json.getAsNumber().intValue());
            case 4:
                return new NBTTagLong(json.getAsNumber().longValue());
            case 5:
                return new NBTTagFloat(json.getAsNumber().floatValue());
            case 6:
                return new NBTTagDouble(json.getAsNumber().doubleValue());
            case 7: {
                JsonArray array = json.getAsJsonArray();
                byte[] values = new byte[array.size()];
                for (int i = 0; i < values.length; i++) values[i] = array.get(i).getAsByte();
                return new NBTTagByteArray(values);
            }
            case 8:
                return new NBTTagString(json.getAsString());
            case 9: {
                NBTTagList list = new NBTTagList();
                if (json.isJsonArray()) {
                    for (JsonElement x : json.getAsJsonArray()) list.appendTag(element(x, (byte) 0));
                } else if (json.isJsonObject()) {
                    for (Map.Entry<String, JsonElement> e : json.getAsJsonObject().entrySet()) {
                        String key = e.getKey();
                        byte t = 0;
                        int colon = key.lastIndexOf(':');
                        if (colon >= 0) {
                            try {
                                t = Byte.parseByte(key.substring(colon + 1));
                            } catch (NumberFormatException ignored) {
                                t = 0;
                            }
                        }
                        list.appendTag(element(e.getValue(), t));
                    }
                }
                return list;
            }
            case 10:
                return json.isJsonObject() ? compound(json.getAsJsonObject()) : new NBTTagCompound();
            case 11: {
                JsonArray array = json.getAsJsonArray();
                int[] values = new int[array.size()];
                for (int i = 0; i < values.length; i++) values[i] = array.get(i).getAsInt();
                return new NBTTagIntArray(values);
            }
            default:
                return new NBTTagString(json.isJsonPrimitive() ? json.getAsString() : json.toString());
        }
    }

    private static byte guessType(JsonElement json) {
        if (json.isJsonPrimitive()) {
            JsonPrimitive p = json.getAsJsonPrimitive();
            if (p.isBoolean()) return 1;
            if (p.isNumber()) return p.getAsString().contains(".") ? (byte) 6 : (byte) 4;
            return 8;
        }
        return json.isJsonArray() ? (byte) 9 : (byte) 10;
    }

    private static String jsonString(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
