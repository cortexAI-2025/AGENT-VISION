package org.agentvision.android

import android.content.pm.PackageManager
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Test instrumenté (nécessite un appareil/émulateur) : garanties du manifeste installé. */
class ManifestSecurityTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun noAccessibilityOrOverlayPermission() {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS or PackageManager.GET_SERVICES)
        val perms = info.requestedPermissions?.toList() ?: emptyList()
        assertFalse(perms.contains("android.permission.BIND_ACCESSIBILITY_SERVICE"))
        assertFalse(perms.contains("android.permission.SYSTEM_ALERT_WINDOW"))
        assertTrue(perms.contains("android.permission.INTERNET"))
    }

    @Test fun cleartextTrafficDisabled() {
        val flags = ctx.applicationInfo.flags
        assertTrue(flags and android.content.pm.ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC == 0)
    }
}
