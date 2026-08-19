pluginManagement {
    repositories {
        // Maven Central first: everything :core needs lives there, so the core
        // module resolves on a machine that cannot reach Google's Maven.
        mavenCentral()
        gradlePluginPortal()
        google()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "loop"

// :core is plain Kotlin/JVM — the models, the HTTP client and the error
// mapping. It builds and tests without the Android SDK, which is what lets
// the contract with the Python server be verified anywhere.
include(":core")

// :app needs the Android SDK. Skipping it when the SDK is absent means
// `gradle :core:test` works on a machine that only has a JDK.
val hasAndroidSdk = System.getenv("ANDROID_HOME") != null ||
    System.getenv("ANDROID_SDK_ROOT") != null ||
    File(rootDir, "local.properties").exists()

if (hasAndroidSdk) {
    include(":app")
} else {
    logger.lifecycle("Android SDK not found - configuring :core only.")
}
