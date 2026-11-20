package dev.gtnhplanner.calcoracle.icons;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonObject;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.ITextureObject;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.IIcon;
import net.minecraft.util.ResourceLocation;
import net.minecraftforge.client.IItemRenderer;
import net.minecraftforge.client.MinecraftForgeClient;
import net.minecraftforge.fluids.FluidRegistry;
import net.minecraftforge.fluids.FluidStack;

/**
 * Recipe and item list stacks that move in game, handed to the quest stack pass
 * (QuestStackIconExporter), which records their animation as it does for quest items. The icon pass
 * renders each stack only once, so all it does is notice which stacks can move:
 * <ul>
 * <li>animated textures: Angelica marks each animated sprite a render uses (it only animates what is
 * on screen), so a stack moves if a sprite is marked after its render;</li>
 * <li>custom item renderers (GregTech's spinning and shader materials, Avaritia's cosmic items): drawn
 * again once the pass is over, minutes later, and kept if the picture changed;</li>
 * <li>fluids with an animated texture, drawn through GregTech's fluid display item.</li>
 * </ul>
 * Stacks with NBT are left out: the site keys those by a hash of their NBT.
 */
final class AnimatedStacks {

    /** Quest stack pass entries ({"k", "id", "dmg"}) by site item key. */
    static final Map<String, JsonObject> ENTRIES = new LinkedHashMap<String, JsonObject>();
    private static final Map<String, Object[]> CUSTOM = new LinkedHashMap<String, Object[]>();
    private static Iterator<Map.Entry<String, Object[]>> recheck;
    private static int customMoved;

    private static List<Object> sprites;
    private static Method needsUpdate, unmark;
    private static boolean lookedUp, dirty = true;

    private AnimatedStacks() {}

    /** At the start of a frame of the icon pass: the game has drawn other things since the last render. */
    static void newFrame() {
        dirty = true;
    }

    /** Before a stack's icon render: forget which animated sprites were used so far. */
    static void beforeRender() {
        lookUp();
        if (sprites == null || !dirty) return;
        dirty = false;
        for (Object sprite : sprites) {
            try {
                unmark.invoke(sprite);
            } catch (Throwable ignored) {
                // a sprite without the method: nothing to forget
            }
        }
    }

    /** After the render of {@code stack}: notes it when the render used an animated sprite or a custom renderer. */
    static void afterRender(ItemStack stack, int[] pixels) {
        boolean animated = false;
        if (sprites != null) {
            // Unmark what this render used, so the next render in this frame starts clean.
            for (Object sprite : sprites) {
                try {
                    if (Boolean.TRUE.equals(needsUpdate.invoke(sprite))) {
                        animated = true;
                        unmark.invoke(sprite);
                    }
                } catch (Throwable ignored) {
                    // keep looking
                }
            }
        }
        String key = siteKey(stack);
        if (key == null || ENTRIES.containsKey(key)) return;
        if (animated) {
            add(key, stack);
            return;
        }
        try {
            if (MinecraftForgeClient.getItemRenderer(stack, IItemRenderer.ItemRenderType.INVENTORY) != null) {
                CUSTOM.put(key, new Object[] { stack.copy(), Integer.valueOf(Arrays.hashCode(pixels)) });
            }
        } catch (Throwable ignored) {
            // no renderer to ask
        }
    }

    /**
     * Draws the custom-rendered stacks again, as many as fit in {@code budgetNanos}; true once all are
     * done. Called after the icon pass, so the game clock and GregTech's animation counter have moved on.
     */
    static boolean recheckCustomRenderers(long budgetNanos) {
        if (recheck == null) {
            recheck = CUSTOM.entrySet().iterator();
            GtnhCalcOracleMod.LOG.info("Animated stacks: " + ENTRIES.size() + " with animated textures; drawing "
                + CUSTOM.size() + " custom-rendered stacks again.");
        }
        long start = System.nanoTime();
        while (recheck.hasNext() && System.nanoTime() - start < budgetNanos) {
            Map.Entry<String, Object[]> e = recheck.next();
            ItemStack stack = (ItemStack) e.getValue()[0];
            try {
                int[] again = ClientItemStackIconRenderer.renderStackPixels(stack);
                if (Arrays.hashCode(again) != ((Integer) e.getValue()[1]).intValue()) {
                    add(e.getKey(), stack);
                    customMoved++;
                }
            } catch (Throwable ignored) {
                ClientItemStackIconRenderer.resetTessellator();
            }
        }
        if (recheck.hasNext()) return false;
        GtnhCalcOracleMod.LOG.info("Animated stacks: " + customMoved + " custom-rendered stacks moved.");
        CUSTOM.clear();
        return true;
    }

    /** Notes a fluid whose icon is an animated texture. */
    static void noteFluid(FluidStack fluid, IIcon icon) {
        if (fluid == null || fluid.tag != null || fluid.getFluid() == null) return;
        if (!(icon instanceof TextureAtlasSprite) || ((TextureAtlasSprite) icon).getFrameCount() <= 1) return;
        if (!(Item.itemRegistry.getObject(FLUID_DISPLAY) instanceof Item)) return;
        String name = fluid.getFluid().getName();
        int id = FluidRegistry.getFluidID(name);
        if (id < 0) return;
        JsonObject entry = new JsonObject();
        entry.addProperty("k", "fluid:" + name);
        entry.addProperty("id", FLUID_DISPLAY);
        entry.addProperty("dmg", Integer.valueOf(id));
        ENTRIES.put("fluid:" + name, entry);
    }

    private static final String FLUID_DISPLAY = "gregtech:gt.GregTech_FluidDisplay";

    /** The site's key of a stack without NBT ("registry name@damage"), or null. */
    private static String siteKey(ItemStack stack) {
        if (stack == null || stack.getItem() == null || stack.hasTagCompound()) return null;
        Object name = Item.itemRegistry.getNameForObject(stack.getItem());
        return name == null ? null : name + "@" + stack.getItemDamage();
    }

    private static void add(String key, ItemStack stack) {
        JsonObject entry = new JsonObject();
        entry.addProperty("k", key);
        entry.addProperty("id", key.substring(0, key.lastIndexOf('@')));
        entry.addProperty("dmg", Integer.valueOf(stack.getItemDamage()));
        ENTRIES.put(key, entry);
    }

    /**
     * The animated sprites of the block and item atlases, and Angelica's methods that tell whether a
     * sprite was used since it was last unmarked. Without Angelica only the custom renderers are checked.
     */
    private static void lookUp() {
        if (lookedUp) return;
        lookedUp = true;
        try {
            Map<Object, Boolean> found = new IdentityHashMap<Object, Boolean>();
            ResourceLocation[] atlases = { TextureMap.locationBlocksTexture, TextureMap.locationItemsTexture };
            for (ResourceLocation atlas : atlases) {
                ITextureObject texture = Minecraft.getMinecraft().getTextureManager().getTexture(atlas);
                if (texture == null) continue;
                // TextureMap keeps its sprites in private maps (names differ between dev and obfuscated runs).
                for (Class<?> c = texture.getClass(); c != null; c = c.getSuperclass()) {
                    for (Field f : c.getDeclaredFields()) {
                        if (!Map.class.isAssignableFrom(f.getType()) && !Collection.class.isAssignableFrom(f.getType())) {
                            continue;
                        }
                        f.setAccessible(true);
                        Object v = f.get(texture);
                        Collection<?> values = v instanceof Map ? ((Map<?, ?>) v).values() : (Collection<?>) v;
                        if (values == null) continue;
                        for (Object o : values) {
                            if (o instanceof TextureAtlasSprite && ((TextureAtlasSprite) o).hasAnimationMetadata()) {
                                found.put(o, Boolean.TRUE);
                            }
                        }
                    }
                }
            }
            if (found.isEmpty()) return;
            Class<?> spriteClass = found.keySet().iterator().next().getClass();
            for (Method m : spriteClass.getMethods()) {
                if (m.getParameterTypes().length != 0) continue;
                String n = m.getName();
                if (n.endsWith("$unmarkNeedsAnimationUpdate")) unmark = m;
                else if (n.endsWith("$needsAnimationUpdate") && m.getReturnType() == boolean.class) needsUpdate = m;
            }
            if (unmark == null || needsUpdate == null) {
                GtnhCalcOracleMod.LOG.info("Animated stacks: sprite usage is not tracked here; only custom renderers are checked.");
                return;
            }
            sprites = new ArrayList<Object>(found.keySet());
            GtnhCalcOracleMod.LOG.info("Animated stacks: " + sprites.size() + " animated sprites tracked.");
        } catch (Throwable t) {
            sprites = null;
            GtnhCalcOracleMod.LOG.warn("Animated stacks: could not look up the animated sprites: " + t);
        }
    }
}
