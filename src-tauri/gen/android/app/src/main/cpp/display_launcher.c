#include <jni.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/types.h>
#include <grp.h>

JNIEXPORT jintArray JNICALL
Java_io_github_kiramei_baas_1tauri_PrivilegedDisplayBridge_spawnBackend(
        JNIEnv *env, jclass clazz, jstring apk_path, jstring main_class) {
    (void) clazz;
    int to_child[2];
    int from_child[2];
    if (pipe(to_child) != 0) return NULL;
    if (pipe(from_child) != 0) {
        close(to_child[0]);
        close(to_child[1]);
        return NULL;
    }

    const char *apk = (*env)->GetStringUTFChars(env, apk_path, NULL);
    const char *entry = (*env)->GetStringUTFChars(env, main_class, NULL);
    if (apk == NULL || entry == NULL) {
        if (apk != NULL) (*env)->ReleaseStringUTFChars(env, apk_path, apk);
        if (entry != NULL) (*env)->ReleaseStringUTFChars(env, main_class, entry);
        close(to_child[0]);
        close(to_child[1]);
        close(from_child[0]);
        close(from_child[1]);
        return NULL;
    }
    pid_t pid = fork();
    if (pid == 0) {
        dup2(to_child[0], STDIN_FILENO);
        dup2(from_child[1], STDOUT_FILENO);
        close(to_child[0]);
        close(to_child[1]);
        close(from_child[0]);
        close(from_child[1]);
        gid_t groups[] = {1000, 1003, 1004, 1007, 1015, 1023, 1078, 3001, 3002, 3003};
        setgroups(sizeof(groups) / sizeof(groups[0]), groups);
        if (setresgid(1000, 1000, 1000) != 0 || setresuid(1000, 1000, 1000) != 0) _exit(120);
        setenv("CLASSPATH", apk, 1);
        execl("/system/bin/app_process", "app_process", "/system/bin",
              "--nice-name=baas_display_backend", entry, (char *) NULL);
        _exit(121);
    }

    (*env)->ReleaseStringUTFChars(env, apk_path, apk);
    (*env)->ReleaseStringUTFChars(env, main_class, entry);
    close(to_child[0]);
    close(from_child[1]);
    if (pid < 0) {
        close(to_child[1]);
        close(from_child[0]);
        return NULL;
    }
    jint values[] = {(jint) pid, to_child[1], from_child[0]};
    jintArray result = (*env)->NewIntArray(env, 3);
    (*env)->SetIntArrayRegion(env, result, 0, 3, values);
    return result;
}
