package dev.gtnhplanner.calcoracle.nei;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.util.ResourceLocation;

/**
 * A font renderer that records the strings drawn with it instead of drawing them. It stands in for
 * Minecraft's font renderer while a recipe handler draws its text, so the exporter can read the
 * lines NEI would show. Widths and wrapping are delegated to the real renderer.
 */
public final class RecordingFontRenderer extends FontRenderer {

    public static final class Line {

        public final String text;
        public final int x;
        public final int y;

        Line(String text, int x, int y) {
            this.text = text;
            this.x = x;
            this.y = y;
        }
    }

    private final FontRenderer real;
    public final List<Line> lines = new ArrayList<Line>();

    public RecordingFontRenderer(Minecraft mc, FontRenderer real) {
        super(mc.gameSettings, new ResourceLocation("textures/font/ascii.png"), mc.renderEngine, real.getUnicodeFlag());
        this.real = real;
    }

    @Override
    public int drawString(String text, int x, int y, int color) {
        return record(text, x, y);
    }

    @Override
    public int drawString(String text, int x, int y, int color, boolean shadow) {
        return record(text, x, y);
    }

    @Override
    public int drawStringWithShadow(String text, int x, int y, int color) {
        return record(text, x, y);
    }

    private int record(String text, int x, int y) {
        if (text != null) {
            lines.add(new Line(text, x, y));
        }
        return x + getStringWidth(text);
    }

    @Override
    public int getStringWidth(String text) {
        return real.getStringWidth(text);
    }

    @Override
    public int getCharWidth(char c) {
        return real.getCharWidth(c);
    }

    @Override
    public String trimStringToWidth(String text, int width) {
        return real.trimStringToWidth(text, width);
    }

    @Override
    public String trimStringToWidth(String text, int width, boolean reverse) {
        return real.trimStringToWidth(text, width, reverse);
    }

    @Override
    @SuppressWarnings("rawtypes")
    public List listFormattedStringToWidth(String text, int width) {
        return real.listFormattedStringToWidth(text, width);
    }
}
