package dev.gtnhplanner.calcoracle;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import net.minecraft.client.Minecraft;

public final class ClientAutorunHandler {

    private int ticks;
    private boolean started;

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END || started) {
            return;
        }

        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft == null || minecraft.getTextureManager() == null || minecraft.fontRenderer == null) {
            return;
        }

        // Some item renderers and adapters need a loaded world and player, so optionally wait until the client
        // has joined a world and count the delay from there instead of from the main menu.
        if (Boolean.getBoolean("gtnh.oracle.waitForWorld") && (minecraft.theWorld == null || minecraft.thePlayer == null)) {
            ticks = 0;
            return;
        }

        ticks++;
        if (ticks < Integer.getInteger("gtnh.oracle.autorunDelayTicks", 220)) {
            return;
        }

        started = true;
        GtnhCalcOracleMod.LOG.info("GTNH calculation oracle client is ready after {} ticks.", Integer.valueOf(ticks));
        GtnhCalcOracleMod.requestAutorunExport("client-tick");
    }
}
