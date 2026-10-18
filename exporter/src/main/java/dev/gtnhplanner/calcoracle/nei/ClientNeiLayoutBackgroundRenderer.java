package dev.gtnhplanner.calcoracle.nei;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;
import dev.gtnhplanner.calcoracle.icons.IconPixels;
import dev.gtnhplanner.calcoracle.icons.PngWriter;
import net.minecraft.client.shader.Framebuffer;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import java.io.File;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.security.MessageDigest;

public final class ClientNeiLayoutBackgroundRenderer {

    private ClientNeiLayoutBackgroundRenderer() {}

    public static String capture(
        Object handler,
        int recipeIndex,
        String type,
        String signature,
        int width,
        int height
    ) {
        String outputDir = System.getProperty("gtnh.oracle.neiLayoutDir", "");
        if (outputDir.length() == 0) {
            return null;
        }

        String fileName = "nei-" + safeName(type) + "-" + sha1(signature).substring(0, 12) + ".png";
        File dir = new File(outputDir);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            return null;
        }
        File output = new File(dir, fileName);

        Framebuffer framebuffer = new Framebuffer(width, height, true);
        boolean projectionPushed = false;
        boolean modelViewPushed = false;
        try {
            framebuffer.bindFramebuffer(true);
            GL11.glViewport(0, 0, width, height);
            GL11.glClearColor(0.0F, 0.0F, 0.0F, 0.0F);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);

            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPushMatrix();
            projectionPushed = true;
            GL11.glLoadIdentity();
            GL11.glOrtho(0.0D, width, height, 0.0D, 1000.0D, 3000.0D);

            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPushMatrix();
            modelViewPushed = true;
            GL11.glLoadIdentity();
            GL11.glTranslatef(0.0F, 0.0F, -2000.0F);
            GL11.glEnable(GL11.GL_BLEND);

            Method drawBackground = handler.getClass().getMethod("drawBackground", Integer.TYPE);
            drawBackground.invoke(handler, Integer.valueOf(recipeIndex));
            GL11.glFlush();

            ByteBuffer buffer = BufferUtils.createByteBuffer(width * height * 4);
            GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buffer);
            PngWriter.write(IconPixels.argbFromRgba(buffer, width, height), width, height, output);
        } catch (Throwable t) {
            GtnhCalcOracleMod.LOG.warn("Could not render NEI handler background for {}.", signature, t);
            return null;
        } finally {
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
            framebuffer.deleteFramebuffer();
        }

        String datasetVersionId = System.getProperty("gtnh.oracle.datasetVersionId", "");
        return datasetVersionId.length() == 0
            ? output.getAbsolutePath()
            : "/datasets/gtnh/" + datasetVersionId + "/textures/nei-layouts/" + fileName;
    }

    private static String safeName(String value) {
        return value == null ? "nei" : value.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static String sha1(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] data = digest.digest(String.valueOf(value).getBytes("UTF-8"));
            StringBuilder builder = new StringBuilder();
            for (byte b : data) {
                builder.append(String.format("%02x", Byte.valueOf(b)));
            }
            return builder.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
