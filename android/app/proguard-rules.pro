# Minification is disabled for release builds, so this file is mostly a
# safeguard in case it is ever turned on.

# Methods reachable only from JavaScript have no Java callers, so shrinking
# would strip them and silently break the bridge.
-keepclassmembers class dev.voidmusic.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}

-keepattributes JavascriptInterface
-keepattributes *Annotation*
