plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.voidmusic.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voidmusic.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0-native"
    }

    buildFeatures {
        compose = true
    }

    // Same reasoning as the WebView app's signing setup: one stable key so
    // every build upgrades in place instead of requiring an uninstall.
    signingConfigs {
        create("shared") {
            storeFile = if (project.hasProperty("VOID_KEYSTORE"))
                file(project.property("VOID_KEYSTORE") as String)
            else rootProject.file("../android/keystore/void-signing.jks")
            storePassword = project.findProperty("VOID_KEYSTORE_PASSWORD") as String? ?: "voidmusic"
            keyAlias = project.findProperty("VOID_KEY_ALIAS") as String? ?: "void"
            keyPassword = project.findProperty("VOID_KEY_PASSWORD") as String? ?: "voidmusic"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Playback. Media3/ExoPlayer is the same engine class the WebView app's
    // <audio> element ultimately rides on top of via the platform, made explicit
    // here since a native app owns its own playback pipeline.
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("io.coil-kt.coil3:coil-compose:3.0.4")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
}
