package dev.gtnhplanner.calcoracle.nei;

import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.call;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.callStatic;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.field;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.iterable;
import static dev.gtnhplanner.calcoracle.nei.NeiHandlerExporter.staticField;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import net.minecraft.client.Minecraft;
import net.minecraft.item.ItemStack;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * Records NEI's item list as the item panel shows it: every stack in NEI's sort order (ItemList.items
 * after ItemListLoader sorted it), the collapsible group each one belongs to, whether the default
 * filters show it, and its tooltip (ItemStack.getTooltip, the lines NEI's "#" search matches and the
 * tooltip draws).
 *
 * NEI loads the list on its own threads once the player has joined a world, so this waits for
 * ItemList.loadFinished first. Reflection only, like NeiHandlerExporter.
 */
public final class NeiItemListExporter {

    private final NeiHandlerExporter.Resources resources;
    public final List<String> warnings = new ArrayList<String>();

    public NeiItemListExporter(NeiHandlerExporter.Resources resources) {
        this.resources = resources;
    }

    public Map<String, Object> export(long waitMillis) throws InterruptedException {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        long deadline = System.currentTimeMillis() + waitMillis;
        while (!Boolean.TRUE.equals(staticField("codechicken.nei.ItemList", "loadFinished"))) {
            if (System.currentTimeMillis() > deadline) {
                warn("NEI's item list did not finish loading");
                return out;
            }
            Thread.sleep(500);
        }

        Object filter = callStatic("codechicken.nei.ItemList", "getItemListFilter");
        List<Object> groups = new ArrayList<Object>();
        for (Object group : iterable(staticField("codechicken.nei.CollapsibleItems", "groups"))) {
            Map<String, Object> g = new LinkedHashMap<String, Object>();
            Object name = field(group, "displayName");
            g.put("name", name == null ? "" : String.valueOf(name));
            g.put("expanded", Boolean.valueOf(Boolean.TRUE.equals(field(group, "expanded"))));
            groups.add(g);
        }

        List<Object> items = new ArrayList<Object>();
        List<ItemStack> stacks = new ArrayList<ItemStack>();
        int tooltipFailures = 0;
        int identFailures = 0;
        Object identifiers = identifierFilter();
        Object list = staticField("codechicken.nei.ItemList", "items");
        for (Object o : new ArrayList<Object>(listOrEmpty(list))) {
            if (!(o instanceof ItemStack)) {
                continue;
            }
            ItemStack stack = (ItemStack) o;
            Map<String, Object> item;
            try {
                item = resources.item(stack.stackSize > 0 ? stack : withSize(stack));
            } catch (Throwable t) {
                warn("item " + stack + ": " + t);
                continue;
            }
            if (item == null) {
                continue;
            }
            Object group = callStatic("codechicken.nei.CollapsibleItems", "getGroupIndex", stack);
            if (group instanceof Number && ((Number) group).intValue() >= 0) {
                item.put("group", group);
            }
            if (filter != null && !matches(filter, stack)) {
                item.put("hidden", Boolean.TRUE);
            }
            try {
                List<String> lines = tooltip(stack);
                if (!lines.isEmpty()) {
                    item.put("tooltip", lines);
                }
                Object rarity = field(stack.getRarity(), "rarityColor");
                if (rarity != null) {
                    item.put("rarity", String.valueOf(rarity));
                }
            } catch (Throwable t) {
                if (tooltipFailures++ < 5) {
                    warn("tooltip " + stack + ": " + t);
                }
            }
            String ident = identifier(identifiers, stack);
            if (ident != null) {
                item.put("ident", ident);
            } else if (identifiers != null && identFailures++ < 5) {
                warn("no identifier for " + stack);
            }
            items.add(item);
            stacks.add(stack);
        }
        if (tooltipFailures > 5) {
            warn(tooltipFailures + " tooltips failed");
        }
        if (identifiers == null) {
            warn("no IdentifierFilter: the & search keeps registry names only");
        }
        out.put("groups", groups);
        out.put("items", items);
        try {
            out.put("subsets", subsets(stacks));
        } catch (Throwable t) {
            warn("subsets: " + t);
        }
        return out;
    }

    /**
     * The text NEI's identifier search (&) matches for a stack, as IdentifierFilter.matches builds it:
     * "registry name\nnumeric id:damage", or for a fluid display stack "fluid name\nfluid id".
     */
    private static String identifier(Object filter, ItemStack stack) {
        if (filter == null) {
            return null;
        }
        Object fluid = null;
        if (Boolean.TRUE.equals(callStatic("codechicken.nei.recipe.StackInfo", "isFluidDisplayItem", stack))) {
            fluid = callStatic("codechicken.nei.recipe.StackInfo", "getFluid", stack);
        }
        Object name = fluid != null ? call(filter, "getFluidStringIdentifier", fluid) : call(filter, "getStringIdentifier", stack);
        Object id = fluid != null ? call(filter, "getFluidIdentifier", fluid) : call(filter, "getIdentifier", stack);
        return name == null || id == null ? null : name + "\n" + id;
    }

    private static Object identifierFilter() {
        try {
            return Class.forName("codechicken.nei.search.IdentifierFilter").getConstructor(Pattern.class)
                .newInstance(Pattern.compile(""));
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * NEI's item subsets (SubsetWidget.tags: mods, creative tabs, Items/Blocks and the rest), the "%"
     * search and the subsets dropdown read: each tag's full name and the positions in the exported
     * item list of the stacks its filter matches, as [start, length] runs. Tags NEI made up as parents
     * (no filter) and tags that match nothing are left out.
     */
    private List<Object> subsets(List<ItemStack> stacks) {
        List<Object> out = new ArrayList<Object>();
        Object tags = staticField("codechicken.nei.SubsetWidget", "tags");
        if (!(tags instanceof Map)) {
            warn("no subset tags");
            return out;
        }
        List<Object> snapshot;
        synchronized (tags) {
            snapshot = new ArrayList<Object>(((Map<?, ?>) tags).values());
        }
        int failures = 0;
        for (Object tag : snapshot) {
            Object name = field(tag, "fullname");
            Object filter = field(tag, "filter");
            if (name == null || filter == null || filter.getClass().getName().endsWith("NothingItemFilter")) {
                continue;
            }
            Method matches;
            try {
                matches = filter.getClass().getMethod("matches", ItemStack.class);
                matches.setAccessible(true);
            } catch (Throwable t) {
                continue;
            }
            List<Object> runs = new ArrayList<Object>();
            int start = -1;
            for (int i = 0; i <= stacks.size(); i++) {
                boolean in = false;
                if (i < stacks.size()) {
                    try {
                        in = Boolean.TRUE.equals(matches.invoke(filter, stacks.get(i)));
                    } catch (Throwable t) {
                        failures++;
                    }
                }
                if (in && start < 0) {
                    start = i;
                } else if (!in && start >= 0) {
                    runs.add(Integer.valueOf(start));
                    runs.add(Integer.valueOf(i - start));
                    start = -1;
                }
            }
            if (!runs.isEmpty()) {
                Map<String, Object> s = new LinkedHashMap<String, Object>();
                s.put("name", String.valueOf(name));
                s.put("items", runs);
                out.add(s);
            }
        }
        if (failures > 0) {
            warn("subsets: " + failures + " filter checks failed");
        }
        return out;
    }

    /** ItemStack.getTooltip as NEI's search reads it (not advanced); the first line is the name. */
    @SuppressWarnings("unchecked")
    private static List<String> tooltip(ItemStack stack) {
        List<String> out = new ArrayList<String>();
        List<String> lines = stack.copy().getTooltip(Minecraft.getMinecraft().thePlayer, false);
        if (lines != null) {
            for (Object line : lines) {
                out.add(line == null ? "" : String.valueOf(line));
            }
        }
        return out;
    }

    private static boolean matches(Object filter, ItemStack stack) {
        try {
            Object r = filter.getClass().getMethod("matches", ItemStack.class).invoke(filter, stack);
            return !Boolean.FALSE.equals(r);
        } catch (Throwable t) {
            return true;
        }
    }

    private static ItemStack withSize(ItemStack stack) {
        ItemStack copy = stack.copy();
        copy.stackSize = 1;
        return copy;
    }

    private static List<?> listOrEmpty(Object list) {
        return list instanceof List ? (List<?>) list : new ArrayList<Object>();
    }

    private void warn(String message) {
        if (warnings.size() < 50) {
            warnings.add(message);
        }
        GtnhCalcOracleMod.LOG.warn("NEI item list export: {}", message);
    }
}
