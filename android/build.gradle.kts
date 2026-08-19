// Deliberately empty of plugin declarations.
//
// Listing the Android plugin here with `apply false` still forces Gradle to
// resolve it during configuration, which fails on a machine without access to
// Google's Maven. Each module declares the plugins it actually uses, so
// `gradle :core:test` needs nothing but Maven Central.

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
