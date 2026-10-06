package dev.gtnhplanner.calcoracle.nei;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * Records what NEI shows for the recipe handlers the site draws: each handler's name, tab info,
 * catalysts and order, and for GregTech recipe maps the layout GregTech builds for NEI (the
 * ModularUI template), the recipes in NEI's order (hidden ones left out) and the description lines
 * under each recipe.
 *
 * Everything goes through reflection, so the exporter keeps compiling and running when NEI, GT or
 * ModularUI change shape; whatever cannot be read is left out and reported in the warnings.
 */
public final class NeiHandlerExporter {

    /** Turns an item stack into the exporter's resource map. */
    public interface Resources {

        Map<String, Object> item(ItemStack stack);
    }

    private final Resources resources;
    /** GT recipe -> [map id, index in the exported map]. */
    private final Map<Object, Object[]> gtRecipeRefs;
    public final List<String> warnings = new ArrayList<String>();
    private boolean descriptionWarned;

    public NeiHandlerExporter(Resources resources, Map<Object, Object[]> gtRecipeRefs) {
        this.resources = resources;
        this.gtRecipeRefs = gtRecipeRefs;
    }

    public Map<String, Object> export() {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        List<Map<String, Object>> handlers = new ArrayList<Map<String, Object>>();
        Object list = staticField("codechicken.nei.recipe.GuiCraftingRecipe", "craftinghandlers");
        int index = 0;
        for (Object handler : iterable(list)) {
            try {
                Map<String, Object> h = handler(handler, index);
                if (h != null) {
                    handlers.add(h);
                }
            } catch (Throwable t) {
                warn(handler.getClass().getName() + ": " + t);
            }
            index++;
        }
        out.put("handlers", handlers);
        out.put("fuels", fuels());
        try {
            out.put("gtLookup", gtLookup());
        } catch (Throwable t) {
            warn("gtLookup: " + t);
        }
        return out;
    }

    // ------------------------------------------------------------------------------------- GT lookups

    /**
     * What GTNEIDefaultHandler adds to a lookup besides the item itself (loadCraftingRecipes and
     * loadUsageRecipes): GregTech's unification (equivalent items and the one GT turns them into),
     * the "familiar" prefixes (dust, small and tiny dust; ingot and nugget; every ore stone), the
     * fluid in a container and every container of that fluid, and the nanochip circuit components.
     * Items are written as "registryId@meta" so this stays small and needs no icons.
     */
    private Map<String, Object> gtLookup() {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        try {
            out.put("unification", unification());
        } catch (Throwable t) {
            warn("gtLookup unification: " + t);
        }
        try {
            out.put("fluidContainers", fluidContainers());
        } catch (Throwable t) {
            warn("gtLookup fluid containers: " + t);
        }
        out.put("recipeAssociations", associations("NEI_RECIPE_ASSOCIATIONS"));
        out.put("usageAssociations", associations("NEI_USAGE_ASSOCIATIONS"));
        try {
            out.put("componentFamiliar", componentFamiliar());
        } catch (Throwable t) {
            warn("gtLookup GT++ components: " + t);
        }
        try {
            out.put("dataSticks", dataSticks());
        } catch (Throwable t) {
            warn("gtLookup data sticks: " + t);
        }
        try {
            fluidDisplay(out);
        } catch (Throwable t) {
            warn("gtLookup fluid display: " + t);
        }
        return out;
    }

    /**
     * GT++ components (BaseItemComponent): the same material's items of the familiar prefixes, which
     * GTNEIDefaultHandler adds for "R" on them.
     */
    private Map<String, Object> componentFamiliar() throws Exception {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Class<?> component = Class.forName("gtPlusPlus.core.item.base.BaseItemComponent");
        for (Object item : Item.itemRegistry) {
            if (!component.isInstance(item)) {
                continue;
            }
            Object prefix = call(field(item, "componentType"), "getGtOrePrefix");
            Object material = field(item, "componentMaterial");
            if (prefix == null || material == null) {
                continue;
            }
            List<Object> familiar = new ArrayList<Object>();
            for (Object p : iterable(field(prefix, "mFamiliarPrefixes"))) {
                String k = key(asStack(call(material, "getComponentByPrefix", p, Integer.valueOf(1))));
                if (k != null) {
                    familiar.add(k);
                }
            }
            String self = key(new ItemStack((Item) item, 1, 0));
            if (self != null && !familiar.isEmpty()) {
                out.put(self, familiar);
            }
        }
        return out;
    }

    /**
     * The data sticks GT shows with assembly line recipes (RecipeAssemblyLine.dataSticksForNEI):
     * [stick, its NBT as the export writes it, the recipe's output]. NEI looks up the output for them.
     */
    private List<Object> dataSticks() throws Exception {
        List<Object> out = new ArrayList<Object>();
        Object recipes = staticField("gregtech.api.util.GTRecipe$RecipeAssemblyLine", "sAssemblylineRecipes");
        for (Object recipe : iterable(recipes)) {
            String output = key(asStack(field(recipe, "mOutput")));
            if (output == null) {
                continue;
            }
            for (Object s : iterable(field(recipe, "dataSticksForNEI"))) {
                ItemStack stick = asStack(s);
                String k = key(stick);
                if (k == null || stick.stackTagCompound == null) {
                    continue;
                }
                List<Object> row = new ArrayList<Object>();
                row.add(k);
                row.add(stick.stackTagCompound.toString());
                row.add(output);
                out.add(row);
            }
        }
        return out;
    }

    /**
     * GT's fluid display item (its damage is the fluid id) and Forge's fluid ids, so the build can
     * tell which fluid a display stack stands for (StackInfo.getFluid).
     */
    private void fluidDisplay(Map<String, Object> out) throws Exception {
        Object display = Class.forName("gregtech.api.enums.ItemList").getField("Display_Fluid").get(null);
        Object item = call(display, "getItem");
        if (item instanceof Item) {
            out.put("fluidDisplay", String.valueOf(Item.itemRegistry.getNameForObject(item)));
        }
        Object ids = callStatic("net.minecraftforge.fluids.FluidRegistry", "getRegisteredFluidIDs");
        if (ids instanceof Map) {
            Map<String, Object> fluids = new LinkedHashMap<String, Object>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) ids).entrySet()) {
                fluids.put(String.valueOf(e.getKey()), e.getValue());
            }
            out.put("fluidIds", fluids);
        }
    }

    /**
     * GTOreDictUnificator's associations, grouped by prefix and material ("dustIron"): the items,
     * the one GT unifies them to, those on the unification blacklist, and the unified items of the
     * prefix's familiar prefixes for the same material.
     */
    private List<Map<String, Object>> unification() throws Exception {
        Class<?> unificator = Class.forName("gregtech.api.util.GTOreDictUnificator");
        Class<?> prefixes = Class.forName("gregtech.api.enums.OrePrefixes");
        Method getNoCopy = unificator.getMethod("get_nocopy", boolean.class, ItemStack.class);
        Method isBlacklisted = unificator.getMethod("isBlacklisted", ItemStack.class);
        Method getPrefixed = unificator.getMethod("get", prefixes, Object.class, long.class);
        Object data = staticField(unificator.getName(), "sItemStack2DataMap");
        if (!(data instanceof Map)) {
            warn("gtLookup: GTOreDictUnificator.sItemStack2DataMap not found");
            return new ArrayList<Map<String, Object>>();
        }
        Map<String, Map<String, Object>> groups = new LinkedHashMap<String, Map<String, Object>>();
        for (Map.Entry<?, ?> e : new ArrayList<Map.Entry<?, ?>>(((Map<?, ?>) data).entrySet())) {
            Object itemData = e.getValue();
            if (!Boolean.TRUE.equals(call(itemData, "hasValidPrefixMaterialData"))) {
                continue;
            }
            Object k = e.getKey();
            ItemStack stack = k instanceof ItemStack ? (ItemStack) k : asStack(call(k, "toStack"));
            String key = key(stack);
            if (key == null) {
                continue;
            }
            String name = String.valueOf(itemData);
            Map<String, Object> group = groups.get(name);
            if (group == null) {
                group = new LinkedHashMap<String, Object>();
                group.put("name", name);
                String target = key(asStack(getNoCopy.invoke(null, Boolean.FALSE, stack)));
                if (target != null) {
                    group.put("target", target);
                }
                Object material = field(field(itemData, "mMaterial"), "mMaterial");
                List<Object> familiar = new ArrayList<Object>();
                for (Object p : iterable(field(field(itemData, "mPrefix"), "mFamiliarPrefixes"))) {
                    try {
                        String f = key(asStack(getPrefixed.invoke(null, p, material, Long.valueOf(1))));
                        if (f != null) {
                            familiar.add(f);
                        }
                    } catch (Throwable ignored) {
                    }
                }
                if (!familiar.isEmpty()) {
                    group.put("familiar", familiar);
                }
                group.put("items", new ArrayList<Object>());
                groups.put(name, group);
            }
            listOf(group, "items").add(key);
            if (Boolean.TRUE.equals(isBlacklisted.invoke(null, stack))) {
                listOf(group, "blacklisted").add(key);
            }
        }
        return new ArrayList<Map<String, Object>>(groups.values());
    }

    /** Forge's registered fluid containers: [filled item, fluid name, amount, empty item]. */
    private List<Object> fluidContainers() {
        List<Object> out = new ArrayList<Object>();
        for (Object d : iterable(callStatic("net.minecraftforge.fluids.FluidContainerRegistry", "getRegisteredFluidContainerData"))) {
            String filled = key(asStack(field(d, "filledContainer")));
            Object fluid = call(field(d, "fluid"), "getFluid");
            Object fluidName = call(fluid, "getName");
            if (filled == null || fluidName == null) {
                continue;
            }
            List<Object> row = new ArrayList<Object>();
            row.add(filled);
            row.add(String.valueOf(fluidName));
            Object amount = field(field(d, "fluid"), "amount");
            row.add(amount instanceof Number ? amount : Integer.valueOf(0));
            String empty = key(asStack(field(d, "emptyContainer")));
            if (empty != null) {
                row.add(empty);
            }
            out.add(row);
        }
        return out;
    }

    /** CCNEIRepresentation's maps: item -> the nanochip components NEI also looks up for it. */
    private Map<String, Object> associations(String fieldName) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object map = staticField("gregtech.common.tileentities.machines.multi.nanochip.util.CCNEIRepresentation", fieldName);
        if (!(map instanceof Map)) {
            return out;
        }
        for (Map.Entry<?, ?> e : ((Map<?, ?>) map).entrySet()) {
            String from = key(asStack(e.getKey()));
            if (from == null) {
                continue;
            }
            List<Object> to = new ArrayList<Object>();
            for (Object s : iterable(e.getValue())) {
                String k = key(asStack(s));
                if (k != null) {
                    to.add(k);
                }
            }
            if (!to.isEmpty()) {
                out.put(from, to);
            }
        }
        return out;
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

    private static ItemStack asStack(Object o) {
        return o instanceof ItemStack ? (ItemStack) o : null;
    }

    /** "registryId@meta", as the export's item ids. */
    private static String key(ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return null;
        }
        Object name = Item.itemRegistry.getNameForObject(stack.getItem());
        return name == null ? null : name + "@" + stack.getItemDamage();
    }

    // ------------------------------------------------------------------------------------- handlers

    private Map<String, Object> handler(Object handler, int index) {
        String className = handler.getClass().getName();
        String kind = kindOf(handler, className);
        Map<String, Object> h = new LinkedHashMap<String, Object>();
        h.put("index", Integer.valueOf(index));
        h.put("className", className);
        h.put("kind", kind);
        putString(h, "id", call(handler, "getOverlayIdentifier"));
        putString(h, "handlerId", call(handler, "getHandlerId"));
        putString(h, "name", call(handler, "getRecipeName"));
        putString(h, "tabName", call(handler, "getRecipeTabName"));
        Object order = callStatic("codechicken.nei.NEIClientConfig", "getHandlerOrder", handler);
        if (order instanceof Number) {
            h.put("order", order);
        }
        h.put("info", handlerInfo(handler));
        h.put("catalysts", catalysts(handler));
        if ("gt".equals(kind)) {
            gregtech(handler, h);
        }
        return h;
    }

    private String kindOf(Object handler, String className) {
        if ("codechicken.nei.recipe.ShapedRecipeHandler".equals(className)) return "shaped";
        if ("codechicken.nei.recipe.ShapelessRecipeHandler".equals(className)) return "shapeless";
        if ("codechicken.nei.recipe.FurnaceRecipeHandler".equals(className)) return "smelting";
        for (Class<?> c = handler.getClass(); c != null; c = c.getSuperclass()) {
            if ("gregtech.nei.GTNEIDefaultHandler".equals(c.getName())) return "gt";
        }
        return "other";
    }

    /** GuiRecipeTab.getHandlerInfo: tab icon, recipe height, the gap above it, badges. */
    private Map<String, Object> handlerInfo(Object handler) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object info = callStatic("codechicken.nei.recipe.GuiRecipeTab", "getHandlerInfo", handler);
        if (info == null) {
            return out;
        }
        putString(out, "modName", call(info, "getModName"));
        putString(out, "handlerName", call(info, "getHandlerName"));
        putNumber(out, "height", call(info, "getHeight"));
        putNumber(out, "width", call(info, "getWidth"));
        putNumber(out, "yShift", call(info, "getYShift"));
        putBoolean(out, "showBadge", call(info, "getShowBadge"));
        putBoolean(out, "multiple", call(info, "isMultipleWidgetsAllowed"));
        Object stack = call(info, "getItemStack");
        if (stack instanceof ItemStack) {
            Map<String, Object> icon = resources.item((ItemStack) stack);
            if (icon != null) {
                out.put("icon", icon);
            }
        }
        return out;
    }

    private List<Map<String, Object>> catalysts(Object handler) {
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        Object list = callStatic("codechicken.nei.recipe.RecipeCatalysts", "getRecipeCatalysts", handler);
        for (Object positioned : iterable(list)) {
            Object stack = field(positioned, "item");
            if (stack instanceof ItemStack) {
                Map<String, Object> item = resources.item((ItemStack) stack);
                if (item != null) {
                    out.add(item);
                }
            }
        }
        return out;
    }

    /** FurnaceRecipeHandler.afuels: the fuels the smelting handler shows in turn. */
    private List<Map<String, Object>> fuels() {
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        try {
            Class<?> furnace = Class.forName("codechicken.nei.recipe.FurnaceRecipeHandler");
            Object instance = furnace.getConstructor().newInstance();
            call(instance, "newInstance"); // finds the fuels once
            Object list = staticField("codechicken.nei.recipe.FurnaceRecipeHandler", "afuels");
            for (Object pair : iterable(list)) {
                Object stack = field(field(pair, "stack"), "item");
                if (stack instanceof ItemStack) {
                    Map<String, Object> item = resources.item((ItemStack) stack);
                    if (item != null) {
                        out.add(item);
                    }
                }
            }
        } catch (Throwable t) {
            warn("fuels: " + t);
        }
        return out;
    }

    // ------------------------------------------------------------------------------------- GregTech

    private void gregtech(Object handler, Map<String, Object> h) {
        Object category = field(handler, "recipeCategory");
        Object recipeMap = field(handler, "recipeMap");
        putString(h, "map", field(recipeMap, "unlocalizedName"));
        putString(h, "category", field(category, "unlocalizedName"));

        Object uiProperties = field(handler, "uiProperties");
        Object neiProperties = field(handler, "neiProperties");
        Map<String, Object> layout = new LinkedHashMap<String, Object>();
        int[] max = new int[] {
            intField(uiProperties, "maxItemInputs"), intField(uiProperties, "maxItemOutputs"),
            intField(uiProperties, "maxFluidInputs"), intField(uiProperties, "maxFluidOutputs") };
        layout.put("max", ints(max));
        layout.put("amperage", Integer.valueOf(intField(uiProperties, "amperage")));
        layout.put("useSpecialSlot", field(uiProperties, "useSpecialSlot"));
        layout.put("bgSize", size(field(neiProperties, "recipeBackgroundSize")));
        layout.put("bgOffset", pos(field(neiProperties, "recipeBackgroundOffset")));
        Object windowOffset = staticField("gregtech.nei.GTNEIDefaultHandler", "WINDOW_OFFSET");
        layout.put("offset", windowOffset != null ? pos(windowOffset) : ints(new int[] { -5, -11 }));
        layout.put("template", template(handler));

        // NEI's recipes for this tab: hidden recipes left out, sorted the way GT sorts them for NEI.
        List<Integer> recipes = new ArrayList<Integer>();
        List<Object> lines = new ArrayList<Object>();
        TreeSet<Integer> inCounts = new TreeSet<Integer>(), outCounts = new TreeSet<Integer>();
        TreeSet<Integer> fluidInCounts = new TreeSet<Integer>(), fluidOutCounts = new TreeSet<Integer>();
        // drawDescription(CachedDefaultRecipe) in older GT, (CachedDefaultRecipe, int recipeIndex) in newer.
        Method drawDescription = declaredMethod("gregtech.nei.GTNEIDefaultHandler", "drawDescription");
        if (drawDescription == null && !descriptionWarned) {
            descriptionWarned = true;
            warn("GTNEIDefaultHandler.drawDescription not found; no description lines");
        }
        String mapId = String.valueOf(field(recipeMap, "unlocalizedName"));
        Minecraft mc = Minecraft.getMinecraft();
        FontRenderer realFont = mc.fontRenderer;
        RecordingFontRenderer recorder = null;
        try {
            recorder = new RecordingFontRenderer(mc, realFont);
        } catch (Throwable t) {
            warn(mapId + ": no recording font renderer: " + t);
        }
        int missing = 0;
        for (Object cached : iterable(call(handler, "getCache"))) {
            Object recipe = field(cached, "mRecipe");
            Object[] ref = gtRecipeRefs.get(recipe);
            if (ref == null || !mapId.equals(ref[0])) {
                missing++;
                continue;
            }
            recipes.add((Integer) ref[1]);
            inCounts.add(Integer.valueOf(arrayLength(field(recipe, "mInputs"))));
            outCounts.add(Integer.valueOf(arrayLength(field(recipe, "mOutputs"))));
            fluidInCounts.add(Integer.valueOf(arrayLength(field(recipe, "mFluidInputs"))));
            fluidOutCounts.add(Integer.valueOf(arrayLength(field(recipe, "mFluidOutputs"))));
            List<String> text = new ArrayList<String>();
            if (recorder != null && drawDescription != null) {
                recorder.lines.clear();
                try {
                    mc.fontRenderer = recorder;
                    if (drawDescription.getParameterTypes().length == 2) {
                        drawDescription.invoke(handler, cached, Integer.valueOf(lines.size()));
                    } else {
                        drawDescription.invoke(handler, cached);
                    }
                } catch (Throwable t) {
                    if (lines.isEmpty()) {
                        warn(mapId + ": description: " + t);
                    }
                } finally {
                    mc.fontRenderer = realFont;
                }
                for (RecordingFontRenderer.Line line : recorder.lines) {
                    text.add(line.text);
                }
            }
            lines.add(text);
        }
        if (missing > 0) {
            warn(mapId + ": " + missing + " NEI recipes not in the export");
        }
        h.put("recipes", recipes);
        h.put("lines", lines);

        // Positions for recipes with more stacks than the template has slots.
        layout.put("itemIn", positionsByCount(uiProperties, "itemInputPositionsGetter", inCounts, max[0]));
        layout.put("itemOut", positionsByCount(uiProperties, "itemOutputPositionsGetter", outCounts, max[1]));
        layout.put("fluidIn", positionsByCount(uiProperties, "fluidInputPositionsGetter", fluidInCounts, max[2]));
        layout.put("fluidOut", positionsByCount(uiProperties, "fluidOutputPositionsGetter", fluidOutCounts, max[3]));
        h.put("layout", layout);
    }

    private Map<String, Object> positionsByCount(Object uiProperties, String getter, Collection<Integer> counts, int max) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object fn = field(uiProperties, getter);
        if (fn == null) {
            return out;
        }
        for (Integer n : counts) {
            if (n.intValue() <= max) {
                continue;
            }
            Object list = call(fn, "apply", n);
            List<Object> positions = new ArrayList<Object>();
            for (Object p : iterable(list)) {
                positions.add(pos(p));
            }
            out.put(String.valueOf(n), positions);
        }
        return out;
    }

    /**
     * The ModularUI window GregTech builds for this tab (RecipeMapFrontend.createNEITemplate): its
     * background and every widget with its position, size and textures.
     */
    private Map<String, Object> template(Object handler) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object window = field(handler, "modularWindow");
        Object context = field(handler, "templateContext");
        if (window == null) {
            return out;
        }
        out.put("size", size(call(window, "getSize")));
        List<Object> background = new ArrayList<Object>();
        for (Object d : iterable(call(window, "getBackground"))) {
            background.add(drawable(d));
        }
        out.put("background", background);

        Map<Object, String> inventories = new IdentityHashMap<Object, String>();
        String[][] names = new String[][] {
            { "itemInputsInventory", "itemIn" }, { "itemOutputsInventory", "itemOut" }, { "specialSlotInventory", "special" },
            { "fluidInputsInventory", "fluidIn" }, { "fluidOutputsInventory", "fluidOut" } };
        for (String[] n : names) {
            Object inv = field(context, n[0]);
            if (inv != null) {
                inventories.put(inv, n[1]);
            }
        }

        List<Object> widgets = new ArrayList<Object>();
        for (Object widget : iterable(call(window, "getChildren"))) {
            Map<String, Object> w = new LinkedHashMap<String, Object>();
            String type = widget.getClass().getSimpleName();
            w.put("type", type);
            w.put("pos", pos(call(widget, "getPos")));
            w.put("size", size(call(widget, "getSize")));
            List<Object> backgrounds = new ArrayList<Object>();
            for (Object d : iterable(call(widget, "getBackground"))) {
                backgrounds.add(drawable(d));
            }
            if (!backgrounds.isEmpty()) {
                w.put("background", backgrounds);
            }
            Object slot = call(widget, "getMcSlot");
            if (slot != null) {
                String kind = inventories.get(call(slot, "getItemHandler"));
                if (kind != null) {
                    w.put("slot", kind);
                    putNumber(w, "index", call(slot, "getSlotIndex"));
                }
            }
            Object d = field(widget, "drawable");
            if (d != null) {
                w.put("drawable", drawable(d));
            }
            if (type.contains("ProgressBar")) {
                w.put("empty", drawable(field(widget, "emptyTexture")));
                Object full = field(widget, "fullTexture");
                if (full != null && full.getClass().isArray() && Array.getLength(full) > 0) {
                    w.put("full", drawable(Array.get(full, 0)));
                }
                putString(w, "direction", field(widget, "direction"));
                putNumber(w, "imageSize", field(widget, "imageSize"));
            }
            widgets.add(w);
        }
        out.put("widgets", widgets);
        return out;
    }

    /** A ModularUI drawable: its texture and the part of it used, or just its class. */
    private Map<String, Object> drawable(Object d) {
        return drawable(d, 0);
    }

    private Map<String, Object> drawable(Object d, int depth) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        if (d == null || depth > 4) {
            return out;
        }
        out.put("type", d.getClass().getSimpleName());
        Object location = field(d, "location");
        if (location != null) {
            out.put("location", String.valueOf(location));
            putNumber(out, "u0", field(d, "u0"));
            putNumber(out, "v0", field(d, "v0"));
            putNumber(out, "u1", field(d, "u1"));
            putNumber(out, "v1", field(d, "v1"));
            putNumber(out, "imageWidth", field(d, "imageWidth"));
            putNumber(out, "imageHeight", field(d, "imageHeight"));
            putNumber(out, "borderU", field(d, "borderWidthU"));
            putNumber(out, "borderV", field(d, "borderWidthV"));
        }
        // Wrappers (fallbackable textures, colour overrides, lambdas such as DrawableWidget's)
        // hold the real drawable in a field; take the first one that leads to a texture.
        if (location == null) {
            for (Object v : objectFields(d)) {
                Map<String, Object> inner = drawable(v, depth + 1);
                if (inner.containsKey("location") || inner.containsKey("inner")) {
                    out.put("inner", inner);
                    break;
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------------------------- helpers

    private void warn(String message) {
        if (warnings.size() < 50) {
            warnings.add(message);
        }
        GtnhCalcOracleMod.LOG.warn("NEI handler export: {}", message);
    }

    private static List<Object> ints(int[] values) {
        List<Object> out = new ArrayList<Object>();
        for (int v : values) out.add(Integer.valueOf(v));
        return out;
    }

    private List<Object> pos(Object p) {
        return ints(new int[] { intField(p, "x"), intField(p, "y") });
    }

    private List<Object> size(Object s) {
        return ints(new int[] { intField(s, "width"), intField(s, "height") });
    }

    private static int arrayLength(Object array) {
        return array != null && array.getClass().isArray() ? Array.getLength(array) : 0;
    }

    private static void putString(Map<String, Object> out, String key, Object value) {
        if (value != null) {
            out.put(key, String.valueOf(value));
        }
    }

    private static void putNumber(Map<String, Object> out, String key, Object value) {
        if (value instanceof Number) {
            out.put(key, value);
        }
    }

    private static void putBoolean(Map<String, Object> out, String key, Object value) {
        if (value instanceof Boolean) {
            out.put(key, value);
        }
    }

    private static Iterable<?> iterable(Object value) {
        if (value == null) return Collections.emptyList();
        if (value instanceof Iterable) return (Iterable<?>) value;
        if (value.getClass().isArray()) {
            List<Object> out = new ArrayList<Object>();
            for (int i = 0; i < Array.getLength(value); i++) out.add(Array.get(value, i));
            return out;
        }
        return Collections.singletonList(value);
    }

    private static Object field(Object target, String name) {
        if (target == null) return null;
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    /** Values of an object's instance fields that are objects (not numbers, strings or arrays). */
    private static List<Object> objectFields(Object target) {
        List<Object> out = new ArrayList<Object>();
        for (Class<?> c = target.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers()) || f.getType().isPrimitive() || f.getType().isArray()) {
                    continue;
                }
                try {
                    f.setAccessible(true);
                    Object v = f.get(target);
                    if (v != null && v != target && !(v instanceof Number) && !(v instanceof CharSequence)
                        && !(v instanceof Boolean) && !(v instanceof Enum)) {
                        out.add(v);
                    }
                } catch (Throwable ignored) {
                }
            }
        }
        return out;
    }

    private static int intField(Object target, String name) {
        Object v = field(target, name);
        return v instanceof Number ? ((Number) v).intValue() : 0;
    }

    private static Object staticField(String className, String name) {
        try {
            for (Class<?> c = Class.forName(className); c != null; c = c.getSuperclass()) {
                try {
                    Field f = c.getDeclaredField(name);
                    f.setAccessible(true);
                    if (Modifier.isStatic(f.getModifiers())) return f.get(null);
                } catch (NoSuchFieldException ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** Calls a public or declared method by name and argument count (first one that accepts the arguments). */
    private static Object call(Object target, String name, Object... args) {
        if (target == null) return null;
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (!m.getName().equals(name) || m.getParameterTypes().length != args.length || Modifier.isStatic(m.getModifiers())) {
                    continue;
                }
                try {
                    m.setAccessible(true);
                    return m.invoke(target, args);
                } catch (Throwable ignored) {
                }
            }
        }
        for (Method m : target.getClass().getMethods()) {
            if (m.getName().equals(name) && m.getParameterTypes().length == args.length) {
                try {
                    return m.invoke(target, args);
                } catch (Throwable ignored) {
                }
            }
        }
        return null;
    }

    private static Object callStatic(String className, String name, Object... args) {
        try {
            for (Method m : Class.forName(className).getMethods()) {
                if (!m.getName().equals(name) || m.getParameterTypes().length != args.length || !Modifier.isStatic(m.getModifiers())) {
                    continue;
                }
                try {
                    return m.invoke(null, args);
                } catch (IllegalArgumentException ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** A declared method by name taking one or two arguments (signatures change between versions). */
    private static Method declaredMethod(String className, String name) {
        try {
            for (Method m : Class.forName(className).getDeclaredMethods()) {
                int n = m.getParameterTypes().length;
                if (m.getName().equals(name) && (n == 1 || n == 2)) {
                    m.setAccessible(true);
                    return m;
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }
}
