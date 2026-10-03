#!/usr/bin/env bash
set -euo pipefail

instance_root="${1:?Usage: install-ae2fc-nei-compat-shim.sh <instance-root> <runtime-dir> <work-dir>}"
runtime_dir="${2:?Usage: install-ae2fc-nei-compat-shim.sh <instance-root> <runtime-dir> <work-dir>}"
work_dir="${3:?Usage: install-ae2fc-nei-compat-shim.sh <instance-root> <runtime-dir> <work-dir>}"

mods_dir="$instance_root/mods"
required_class="com/glodblock/github/nei/object/IRecipeExtractor.class"
shim_jar="$mods_dir/000-ae2fc-nei-compat-shim.jar"

if find "$mods_dir" -maxdepth 1 -type f -name '*.jar' ! -name "$(basename "$shim_jar")" -print0 \
  | xargs -0 -r -n 1 unzip -l 2>/dev/null \
  | grep -q "$required_class"; then
  echo "AE2FC NEI compatibility classes are already present."
  rm -f "$shim_jar"
  exit 0
fi

echo "AE2FC NEI compatibility classes are missing; installing export-only shim."

src_dir="$work_dir/ae2fc-nei-compat-shim-src"
classes_dir="$work_dir/ae2fc-nei-compat-shim-classes"
rm -rf "$src_dir" "$classes_dir"
mkdir -p \
  "$src_dir/com/glodblock/github/nei/object" \
  "$src_dir/com/glodblock/github/nei/recipes" \
  "$src_dir/com/glodblock/github/nei/recipes/extractor" \
  "$classes_dir"

cat > "$src_dir/com/glodblock/github/nei/object/IRecipeExtractor.java" <<'EOF'
package com.glodblock.github.nei.object;

import java.util.List;

import codechicken.nei.PositionedStack;
import codechicken.nei.recipe.IRecipeHandler;

public interface IRecipeExtractor {
    List<OrderStack<?>> getInputIngredients(List<PositionedStack> rawInputs);

    List<OrderStack<?>> getOutputIngredients(List<PositionedStack> rawOutputs);

    default List<OrderStack<?>> getInputIngredients(List<PositionedStack> rawInputs, IRecipeHandler recipe, int index) {
        return getInputIngredients(rawInputs);
    }

    default List<OrderStack<?>> getOutputIngredients(List<PositionedStack> rawOutputs, IRecipeHandler recipe, int index) {
        return getOutputIngredients(rawOutputs);
    }
}
EOF

cat > "$src_dir/com/glodblock/github/nei/object/IRecipeExtractorLegacy.java" <<'EOF'
package com.glodblock.github.nei.object;

public interface IRecipeExtractorLegacy extends IRecipeExtractor {
    String getClassName();
}
EOF

cat > "$src_dir/com/glodblock/github/nei/object/OrderStack.java" <<'EOF'
package com.glodblock.github.nei.object;

import codechicken.nei.PositionedStack;

public class OrderStack<T> {
    private T stack;
    private int index;
    private Object[] items;

    public OrderStack(T stack, int index) {
        this(stack, index, null);
    }

    public OrderStack(T stack, int index, Object[] items) {
        if (stack == null || index < 0) {
            throw new IllegalArgumentException("Trying to create a null or negative order stack!");
        }
        this.stack = stack;
        this.index = index;
        this.items = items;
    }

    public T getStack() {
        return stack;
    }

    public int getIndex() {
        return index;
    }

    public Object[] getItems() {
        return items;
    }

    public void putStack(T stack) {
        this.stack = stack;
    }

    public void putItems(Object[] items) {
        this.items = items;
    }

    public void setIndex(int index) {
        this.index = index;
    }

    public static OrderStack<?> pack(PositionedStack stack, int index) {
        return null;
    }
}
EOF

cat > "$src_dir/com/glodblock/github/nei/recipes/FluidRecipe.java" <<'EOF'
package com.glodblock.github.nei.recipes;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

import com.glodblock.github.nei.object.IRecipeExtractor;
import com.glodblock.github.nei.object.OrderStack;

import codechicken.nei.recipe.IRecipeHandler;

public final class FluidRecipe {
    private static final HashMap<String, IRecipeExtractor> IDENTIFIERS = new HashMap<String, IRecipeExtractor>();

    private FluidRecipe() {}

    public static void addRecipeMap(String recipeIdentifier, IRecipeExtractor extractor) {
        IDENTIFIERS.put(recipeIdentifier, extractor);
    }

    public static List<String> getSupportRecipes() {
        return new ArrayList<String>(IDENTIFIERS.keySet());
    }

    public static List<OrderStack<?>> getPackageInputs(IRecipeHandler recipe, int index, boolean priority) {
        return new ArrayList<OrderStack<?>>();
    }

    public static List<OrderStack<?>> getPackageOutputs(IRecipeHandler recipe, int index, boolean useOther) {
        return new ArrayList<OrderStack<?>>();
    }

    public static List<OrderStack<?>> getPackageInputsLegacy(IRecipeHandler recipe, int index) {
        return new ArrayList<OrderStack<?>>();
    }

    public static List<OrderStack<?>> getPackageOutputsLegacy(IRecipeHandler recipe, int index, boolean useOther) {
        return new ArrayList<OrderStack<?>>();
    }
}
EOF

cat > "$src_dir/com/glodblock/github/nei/recipes/extractor/GregTech5RecipeExtractor.java" <<'EOF'
package com.glodblock.github.nei.recipes.extractor;

import java.util.ArrayList;
import java.util.List;

import com.glodblock.github.nei.object.IRecipeExtractor;
import com.glodblock.github.nei.object.OrderStack;

import codechicken.nei.PositionedStack;

public class GregTech5RecipeExtractor implements IRecipeExtractor {
    public GregTech5RecipeExtractor(boolean removeSpecial) {}

    @Override
    public List<OrderStack<?>> getInputIngredients(List<PositionedStack> rawInputs) {
        return new ArrayList<OrderStack<?>>();
    }

    @Override
    public List<OrderStack<?>> getOutputIngredients(List<PositionedStack> rawOutputs) {
        return new ArrayList<OrderStack<?>>();
    }
}
EOF

classpath="$(
  {
    find "$mods_dir" "$runtime_dir" "$instance_root/libraries" -type f -name '*.jar' 2>/dev/null || true
    find "$HOME/.gradle/caches/minecraft" -type f -name '*.jar' 2>/dev/null || true
  } | sort | paste -sd ':' -
)"

if [[ -z "$classpath" ]]; then
  echo "Could not build classpath for AE2FC NEI compatibility shim." >&2
  exit 1
fi

javac -source 8 -target 8 -Xlint:-options -cp "$classpath" -d "$classes_dir" $(find "$src_dir" -name '*.java' | sort)
jar cf "$shim_jar" -C "$classes_dir" .
echo "Installed AE2FC NEI compatibility shim: $shim_jar"
