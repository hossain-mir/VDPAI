package com.jarvis.ai

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log

/**
 * Native Quick Settings tile for J.A.R.V.I.S.
 *
 * It is bound by the system through BIND_QUICK_SETTINGS_TILE, so it only exists
 * after the user adds it in Quick Settings -> Edit tiles. Tapping launches the
 * existing Capacitor MainActivity. Android itself opens the App Info screen on
 * a long press, so no extra activity or permission is needed for that gesture.
 */
class JarvisTileService : TileService() {

    override fun onCreate() {
        super.onCreate()
        // Tile state is refreshed again in onStartListening when it becomes visible.
        updateTile()
    }

    override fun onStartListening() {
        super.onStartListening()
        updateTile()
    }

    override fun onTileAdded() {
        super.onTileAdded()
        updateTile()
    }

    override fun onClick() {
        super.onClick()
        updateTile()
        launchApp()
    }

    private fun updateTile() {
        val tile = qsTile ?: return
        tile.state = Tile.STATE_ACTIVE
        tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_core)
        tile.label = getString(R.string.tile_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            tile.contentDescription = getString(R.string.tile_content_description)
        }
        tile.updateTile()
    }

    private fun launchApp() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        } ?: Intent(Intent.ACTION_MAIN).apply {
            setClassName(packageName, "$packageName.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        if (!safeStart(launchIntent)) {
            Log.w(TAG, "Could not launch J.A.R.V.I.S. from the tile.")
        }
    }

    /** Returns false when the system refuses to start the activity. */
    private fun safeStart(intent: Intent): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+: immutable PendingIntent is required for background starts.
            val pending = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
        true
    } catch (error: ActivityNotFoundException) {
        Log.w(TAG, "No activity available for Quick Settings tile intent.", error)
        false
    } catch (error: SecurityException) {
        Log.w(TAG, "System refused Quick Settings tile launch.", error)
        false
    }

    private companion object {
        const val TAG = "JarvisTileService"
    }
}
